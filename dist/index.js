// src/client.ts
import { elizaLogger as elizaLogger8 } from "@elizaos/core";

// src/base.ts
import {
  getEmbeddingZeroVector,
  elizaLogger,
  stringToUuid,
  ActionTimelineType
} from "@elizaos/core";
import {
  Scraper,
  SearchMode
} from "@flooz-link/agent-twitter-client";
import { EventEmitter } from "events";
var RequestQueue = class {
  queue = [];
  processing = false;
  async add(request) {
    return new Promise((resolve, reject) => {
      this.queue.push(async () => {
        try {
          const result = await request();
          resolve(result);
        } catch (error) {
          reject(error);
        }
      });
      this.processQueue();
    });
  }
  async processQueue() {
    if (this.processing || this.queue.length === 0) {
      return;
    }
    this.processing = true;
    while (this.queue.length > 0) {
      const request = this.queue.shift();
      try {
        await request();
      } catch (error) {
        console.error("Error processing request:", error);
        this.queue.unshift(request);
        await this.exponentialBackoff(this.queue.length);
      }
      await this.randomDelay();
    }
    this.processing = false;
  }
  async exponentialBackoff(retryCount) {
    const delay = Math.pow(2, retryCount) * 1e3;
    await new Promise((resolve) => setTimeout(resolve, delay));
  }
  async randomDelay() {
    const delay = Math.floor(Math.random() * 2e3) + 1500;
    await new Promise((resolve) => setTimeout(resolve, delay));
  }
};
var ClientBase = class _ClientBase extends EventEmitter {
  static _twitterClients = {};
  twitterClient;
  runtime;
  twitterConfig;
  directions;
  lastCheckedTweetId = null;
  imageDescriptionService;
  temperature = 0.5;
  requestQueue = new RequestQueue();
  profile;
  async cacheTweet(tweet) {
    if (!tweet) {
      console.warn("Tweet is undefined, skipping cache");
      return;
    }
    this.runtime.cacheManager.set(`twitter/tweets/${tweet.id}`, tweet);
  }
  async getCachedTweet(tweetId) {
    const cached = await this.runtime.cacheManager.get(
      `twitter/tweets/${tweetId}`
    );
    return cached;
  }
  async getTweet(tweetId) {
    const cachedTweet = await this.getCachedTweet(tweetId);
    if (cachedTweet) {
      return cachedTweet;
    }
    const tweet = await this.requestQueue.add(
      () => this.twitterClient.getTweet(tweetId)
    );
    await this.cacheTweet(tweet);
    return tweet;
  }
  callback = null;
  onReady() {
    throw new Error("Not implemented in base class, please call from subclass");
  }
  /**
   * Parse the raw tweet data into a standardized Tweet object.
   */
  parseTweet(raw, depth = 0, maxDepth = 3) {
    var _a, _b, _c, _d, _e, _f, _g, _h, _i, _j, _k, _l, _m, _n, _o, _p, _q, _r, _s, _t, _u, _v, _w, _x, _y, _z, _A, _B, _C, _D, _E, _F, _G, _H, _I, _J, _K, _L, _M, _N, _O, _P, _Q, _R, _S, _T, _U, _V, _W, _X, _Y;
    const canRecurse = depth < maxDepth;
    const quotedStatus = ((_a = raw.quoted_status_result) == null ? void 0 : _a.result) && canRecurse ? this.parseTweet(raw.quoted_status_result.result, depth + 1, maxDepth) : void 0;
    const retweetedStatus = ((_b = raw.retweeted_status_result) == null ? void 0 : _b.result) && canRecurse ? this.parseTweet(
      raw.retweeted_status_result.result,
      depth + 1,
      maxDepth
    ) : void 0;
    const t = {
      bookmarkCount: raw.bookmarkCount ?? ((_c = raw.legacy) == null ? void 0 : _c.bookmark_count) ?? void 0,
      conversationId: raw.conversationId ?? ((_d = raw.legacy) == null ? void 0 : _d.conversation_id_str),
      hashtags: raw.hashtags ?? ((_f = (_e = raw.legacy) == null ? void 0 : _e.entities) == null ? void 0 : _f.hashtags) ?? [],
      html: raw.html,
      id: raw.id ?? raw.rest_id ?? raw.id_str ?? void 0,
      inReplyToStatus: raw.inReplyToStatus,
      inReplyToStatusId: raw.inReplyToStatusId ?? ((_g = raw.legacy) == null ? void 0 : _g.in_reply_to_status_id_str) ?? void 0,
      isQuoted: ((_h = raw.legacy) == null ? void 0 : _h.is_quote_status) === true,
      isPin: raw.isPin,
      isReply: raw.isReply,
      isRetweet: ((_i = raw.legacy) == null ? void 0 : _i.retweeted) === true,
      isSelfThread: raw.isSelfThread,
      // @ts-ignore
      language: (_j = raw.legacy) == null ? void 0 : _j.lang,
      likes: ((_k = raw.legacy) == null ? void 0 : _k.favorite_count) ?? 0,
      name: raw.name ?? ((_n = (_m = (_l = raw == null ? void 0 : raw.user_results) == null ? void 0 : _l.result) == null ? void 0 : _m.legacy) == null ? void 0 : _n.name) ?? ((_r = (_q = (_p = (_o = raw.core) == null ? void 0 : _o.user_results) == null ? void 0 : _p.result) == null ? void 0 : _q.legacy) == null ? void 0 : _r.name),
      mentions: raw.mentions ?? ((_t = (_s = raw.legacy) == null ? void 0 : _s.entities) == null ? void 0 : _t.user_mentions) ?? [],
      permanentUrl: raw.permanentUrl ?? (((_x = (_w = (_v = (_u = raw.core) == null ? void 0 : _u.user_results) == null ? void 0 : _v.result) == null ? void 0 : _w.legacy) == null ? void 0 : _x.screen_name) && raw.rest_id ? `https://x.com/${(_B = (_A = (_z = (_y = raw.core) == null ? void 0 : _y.user_results) == null ? void 0 : _z.result) == null ? void 0 : _A.legacy) == null ? void 0 : _B.screen_name}/status/${raw.rest_id}` : void 0),
      photos: raw.photos ?? (((_E = (_D = (_C = raw.legacy) == null ? void 0 : _C.entities) == null ? void 0 : _D.media) == null ? void 0 : _E.filter((media) => media.type === "photo").map((media) => ({
        id: media.id_str,
        url: media.media_url_https,
        alt_text: media.alt_text
      }))) || []),
      place: raw.place,
      poll: raw.poll ?? null,
      quotedStatus,
      quotedStatusId: raw.quotedStatusId ?? ((_F = raw.legacy) == null ? void 0 : _F.quoted_status_id_str) ?? void 0,
      quotes: ((_G = raw.legacy) == null ? void 0 : _G.quote_count) ?? 0,
      replies: ((_H = raw.legacy) == null ? void 0 : _H.reply_count) ?? 0,
      retweets: ((_I = raw.legacy) == null ? void 0 : _I.retweet_count) ?? 0,
      retweetedStatus,
      retweetedStatusId: ((_J = raw.legacy) == null ? void 0 : _J.retweeted_status_id_str) ?? void 0,
      text: raw.text ?? ((_K = raw.legacy) == null ? void 0 : _K.full_text) ?? void 0,
      thread: raw.thread || [],
      timeParsed: raw.timeParsed ? new Date(raw.timeParsed) : ((_L = raw.legacy) == null ? void 0 : _L.created_at) ? new Date((_M = raw.legacy) == null ? void 0 : _M.created_at) : void 0,
      timestamp: raw.timestamp ?? (((_N = raw.legacy) == null ? void 0 : _N.created_at) ? new Date(raw.legacy.created_at).getTime() / 1e3 : void 0),
      urls: raw.urls ?? ((_P = (_O = raw.legacy) == null ? void 0 : _O.entities) == null ? void 0 : _P.urls) ?? [],
      userId: raw.userId ?? ((_Q = raw.legacy) == null ? void 0 : _Q.user_id_str) ?? void 0,
      username: raw.username ?? ((_U = (_T = (_S = (_R = raw.core) == null ? void 0 : _R.user_results) == null ? void 0 : _S.result) == null ? void 0 : _T.legacy) == null ? void 0 : _U.screen_name) ?? void 0,
      videos: raw.videos ?? ((_X = (_W = (_V = raw.legacy) == null ? void 0 : _V.entities) == null ? void 0 : _W.media) == null ? void 0 : _X.filter(
        (media) => media.type === "video"
      )) ?? [],
      views: ((_Y = raw.views) == null ? void 0 : _Y.count) ? Number(raw.views.count) : 0,
      sensitiveContent: raw.sensitiveContent
    };
    return t;
  }
  constructor(runtime, twitterConfig) {
    super();
    this.runtime = runtime;
    this.twitterConfig = twitterConfig;
    const username = twitterConfig.TWITTER_USERNAME;
    if (_ClientBase._twitterClients[username]) {
      this.twitterClient = _ClientBase._twitterClients[username];
    } else {
      this.twitterClient = new Scraper();
      _ClientBase._twitterClients[username] = this.twitterClient;
    }
    this.directions = "- " + this.runtime.character.style.all.join("\n- ") + "- " + this.runtime.character.style.post.join();
  }
  async init() {
    const username = this.twitterConfig.TWITTER_USERNAME;
    const password = this.twitterConfig.TWITTER_PASSWORD;
    const email = this.twitterConfig.TWITTER_EMAIL;
    let retries = this.twitterConfig.TWITTER_RETRY_LIMIT;
    const twitter2faSecret = this.twitterConfig.TWITTER_2FA_SECRET;
    if (!username) {
      throw new Error("Twitter username not configured");
    }
    const authToken = this.runtime.getSetting("TWITTER_COOKIES_AUTH_TOKEN");
    const ct0 = this.runtime.getSetting("TWITTER_COOKIES_CT0");
    const guestId = this.runtime.getSetting("TWITTER_COOKIES_GUEST_ID");
    const createTwitterCookies = (authToken2, ct02, guestId2) => authToken2 && ct02 && guestId2 ? [
      { key: "auth_token", value: authToken2, domain: ".twitter.com" },
      { key: "ct0", value: ct02, domain: ".twitter.com" },
      { key: "guest_id", value: guestId2, domain: ".twitter.com" }
    ] : null;
    const cachedCookies = await this.getCachedCookies(username) || createTwitterCookies(authToken, ct0, guestId);
    if (cachedCookies) {
      elizaLogger.info("Using cached cookies");
      await this.setCookiesFromArray(cachedCookies);
    }
    elizaLogger.log("Waiting for Twitter login");
    while (retries > 0) {
      try {
        if (await this.twitterClient.isLoggedIn()) {
          elizaLogger.info("Successfully logged in.");
          break;
        } else {
          await this.twitterClient.login(
            username,
            password,
            email,
            twitter2faSecret
          );
          if (await this.twitterClient.isLoggedIn()) {
            elizaLogger.info("Successfully logged in.");
            elizaLogger.info("Caching cookies");
            await this.cacheCookies(
              username,
              await this.twitterClient.getCookies()
            );
            break;
          }
        }
      } catch (error) {
        elizaLogger.error(`Login attempt failed: ${error.message}`);
      }
      retries--;
      elizaLogger.error(
        `Failed to login to Twitter. Retrying... (${retries} attempts left)`
      );
      if (retries === 0) {
        elizaLogger.error("Max retries reached. Exiting login process.");
        throw new Error("Twitter login failed after maximum retries.");
      }
      await new Promise((resolve) => setTimeout(resolve, 2e3));
    }
    this.profile = await this.fetchProfile(username);
    if (this.profile) {
      elizaLogger.log("Twitter user ID:", this.profile.id);
      elizaLogger.log(
        "Twitter loaded:",
        JSON.stringify(this.profile, null, 10)
      );
      this.runtime.character.twitterProfile = {
        id: this.profile.id,
        username: this.profile.username,
        screenName: this.profile.screenName,
        bio: this.profile.bio,
        nicknames: this.profile.nicknames
      };
    } else {
      throw new Error("Failed to load profile");
    }
    await this.loadLatestCheckedTweetId();
    await this.populateTimeline();
  }
  async fetchOwnPosts(count) {
    elizaLogger.debug("fetching own posts");
    const homeTimeline = await this.twitterClient.getUserTweets(
      this.profile.id,
      count
    );
    return homeTimeline.tweets.map((t) => this.parseTweet(t));
  }
  /**
   * Fetch timeline for twitter account, optionally only from followed accounts
   */
  async fetchHomeTimeline(count, following) {
    elizaLogger.debug("fetching home timeline");
    const homeTimeline = following ? await this.twitterClient.fetchFollowingTimeline(count, []) : await this.twitterClient.fetchHomeTimeline(count, []);
    const processedTimeline = homeTimeline.filter((t) => t.__typename !== "TweetWithVisibilityResults").map((tweet) => this.parseTweet(tweet));
    return processedTimeline;
  }
  async fetchTimelineForActions(count) {
    elizaLogger.debug("fetching timeline for actions");
    const agentUsername = this.twitterConfig.TWITTER_USERNAME;
    const homeTimeline = this.twitterConfig.ACTION_TIMELINE_TYPE === ActionTimelineType.Following ? await this.twitterClient.fetchFollowingTimeline(count, []) : await this.twitterClient.fetchHomeTimeline(count, []);
    return homeTimeline.map((tweet) => this.parseTweet(tweet)).filter((tweet) => tweet.username !== agentUsername).slice(0, count);
  }
  async fetchSearchTweets(query, maxTweets, searchMode, cursor) {
    try {
      const timeoutPromise = new Promise(
        (resolve) => setTimeout(() => resolve({ tweets: [] }), 15e3)
      );
      try {
        const result = await this.requestQueue.add(
          async () => await Promise.race([
            this.twitterClient.fetchSearchTweets(
              query,
              maxTweets,
              searchMode,
              cursor
            ),
            timeoutPromise
          ])
        );
        return result ?? { tweets: [] };
      } catch (error) {
        elizaLogger.error("Error fetching search tweets:", error);
        return { tweets: [] };
      }
    } catch (error) {
      elizaLogger.error("Error fetching search tweets:", error);
      return { tweets: [] };
    }
  }
  async populateTimeline() {
    elizaLogger.debug("populating timeline...");
    const cachedTimeline = await this.getCachedTimeline();
    if (cachedTimeline) {
      const existingMemories2 = await this.runtime.messageManager.getMemoriesByRoomIds({
        roomIds: cachedTimeline.map(
          (tweet) => stringToUuid(tweet.conversationId + "-" + this.runtime.agentId)
        )
      });
      const existingMemoryIds2 = new Set(
        existingMemories2.map((memory) => memory.id.toString())
      );
      const someCachedTweetsExist = cachedTimeline.some(
        (tweet) => existingMemoryIds2.has(
          stringToUuid(tweet.id + "-" + this.runtime.agentId)
        )
      );
      if (someCachedTweetsExist) {
        const tweetsToSave2 = cachedTimeline.filter(
          (tweet) => !existingMemoryIds2.has(
            stringToUuid(tweet.id + "-" + this.runtime.agentId)
          )
        );
        console.log({
          processingTweets: tweetsToSave2.map((tweet) => tweet.id).join(",")
        });
        for (const tweet of tweetsToSave2) {
          elizaLogger.log("Saving Tweet", tweet.id);
          const roomId = stringToUuid(
            tweet.conversationId + "-" + this.runtime.agentId
          );
          const userId = tweet.userId === this.profile.id ? this.runtime.agentId : stringToUuid(tweet.userId);
          if (tweet.userId === this.profile.id) {
            await this.runtime.ensureConnection(
              this.runtime.agentId,
              roomId,
              this.profile.username,
              this.profile.screenName,
              "twitter"
            );
          } else {
            await this.runtime.ensureConnection(
              userId,
              roomId,
              tweet.username,
              tweet.name,
              "twitter"
            );
          }
          const content = {
            text: tweet.text,
            url: tweet.permanentUrl,
            source: "twitter",
            inReplyTo: tweet.inReplyToStatusId ? stringToUuid(
              tweet.inReplyToStatusId + "-" + this.runtime.agentId
            ) : void 0
          };
          elizaLogger.log("Creating memory for tweet", tweet.id);
          const memory = await this.runtime.messageManager.getMemoryById(
            stringToUuid(tweet.id + "-" + this.runtime.agentId)
          );
          if (memory) {
            elizaLogger.log(
              "Memory already exists, skipping timeline population"
            );
            break;
          }
          await this.runtime.messageManager.createMemory({
            id: stringToUuid(tweet.id + "-" + this.runtime.agentId),
            userId,
            content,
            agentId: this.runtime.agentId,
            roomId,
            embedding: getEmbeddingZeroVector(),
            createdAt: tweet.timestamp * 1e3
          });
          await this.cacheTweet(tweet);
        }
        elizaLogger.log(
          `Populated ${tweetsToSave2.length} missing tweets from the cache.`
        );
        return;
      }
    }
    const timeline = await this.fetchHomeTimeline(cachedTimeline ? 10 : 50);
    const username = this.twitterConfig.TWITTER_USERNAME;
    const mentionsAndInteractions = await this.fetchSearchTweets(
      `@${username}`,
      20,
      SearchMode.Latest
    );
    const allTweets = [...timeline, ...mentionsAndInteractions.tweets];
    const tweetIdsToCheck = /* @__PURE__ */ new Set();
    const roomIds = /* @__PURE__ */ new Set();
    for (const tweet of allTweets) {
      tweetIdsToCheck.add(tweet.id);
      roomIds.add(
        stringToUuid(tweet.conversationId + "-" + this.runtime.agentId)
      );
    }
    const existingMemories = await this.runtime.messageManager.getMemoriesByRoomIds({
      roomIds: Array.from(roomIds)
    });
    const existingMemoryIds = new Set(
      existingMemories.map((memory) => memory.id)
    );
    const tweetsToSave = allTweets.filter(
      (tweet) => !existingMemoryIds.has(
        stringToUuid(tweet.id + "-" + this.runtime.agentId)
      )
    );
    elizaLogger.debug({
      processingTweets: tweetsToSave.map((tweet) => tweet.id).join(",")
    });
    await this.runtime.ensureUserExists(
      this.runtime.agentId,
      this.profile.username,
      this.runtime.character.name,
      "twitter"
    );
    for (const tweet of tweetsToSave) {
      elizaLogger.log("Saving Tweet", tweet.id);
      const roomId = stringToUuid(
        tweet.conversationId + "-" + this.runtime.agentId
      );
      const userId = tweet.userId === this.profile.id ? this.runtime.agentId : stringToUuid(tweet.userId);
      if (tweet.userId === this.profile.id) {
        await this.runtime.ensureConnection(
          this.runtime.agentId,
          roomId,
          this.profile.username,
          this.profile.screenName,
          "twitter"
        );
      } else {
        await this.runtime.ensureConnection(
          userId,
          roomId,
          tweet.username,
          tweet.name,
          "twitter"
        );
      }
      const content = {
        text: tweet.text,
        url: tweet.permanentUrl,
        source: "twitter",
        inReplyTo: tweet.inReplyToStatusId ? stringToUuid(tweet.inReplyToStatusId) : void 0
      };
      await this.runtime.messageManager.createMemory({
        id: stringToUuid(tweet.id + "-" + this.runtime.agentId),
        userId,
        content,
        agentId: this.runtime.agentId,
        roomId,
        embedding: getEmbeddingZeroVector(),
        createdAt: tweet.timestamp * 1e3
      });
      await this.cacheTweet(tweet);
    }
    await this.cacheTimeline(timeline);
    await this.cacheMentions(mentionsAndInteractions.tweets);
  }
  async setCookiesFromArray(cookiesArray) {
    const cookieStrings = cookiesArray.map(
      (cookie) => `${cookie.key}=${cookie.value}; Domain=${cookie.domain}; Path=${cookie.path}; ${cookie.secure ? "Secure" : ""}; ${cookie.httpOnly ? "HttpOnly" : ""}; SameSite=${cookie.sameSite || "Lax"}`
    );
    await this.twitterClient.setCookies(cookieStrings);
  }
  async saveRequestMessage(message, state) {
    if (message.content.text) {
      const recentMessage = await this.runtime.messageManager.getMemories({
        roomId: message.roomId,
        count: 1,
        unique: false
      });
      if (recentMessage.length > 0 && recentMessage[0].content === message.content) {
        elizaLogger.debug("Message already saved", recentMessage[0].id);
      } else {
        await this.runtime.messageManager.createMemory({
          ...message,
          embedding: getEmbeddingZeroVector()
        });
      }
      await this.runtime.evaluate(message, {
        ...state,
        twitterClient: this.twitterClient
      });
    }
  }
  async loadLatestCheckedTweetId() {
    const latestCheckedTweetId = await this.runtime.cacheManager.get(
      `twitter/${this.profile.username}/latest_checked_tweet_id`
    );
    if (latestCheckedTweetId) {
      this.lastCheckedTweetId = BigInt(latestCheckedTweetId);
    }
  }
  async cacheLatestCheckedTweetId() {
    if (this.lastCheckedTweetId) {
      await this.runtime.cacheManager.set(
        `twitter/${this.profile.username}/latest_checked_tweet_id`,
        this.lastCheckedTweetId.toString()
      );
    }
  }
  async getCachedTimeline() {
    return await this.runtime.cacheManager.get(
      `twitter/${this.profile.username}/timeline`
    );
  }
  async cacheTimeline(timeline) {
    await this.runtime.cacheManager.set(
      `twitter/${this.profile.username}/timeline`,
      timeline,
      { expires: Date.now() + 10 * 1e3 }
    );
  }
  async cacheMentions(mentions) {
    await this.runtime.cacheManager.set(
      `twitter/${this.profile.username}/mentions`,
      mentions,
      { expires: Date.now() + 10 * 1e3 }
    );
  }
  async getCachedCookies(username) {
    return await this.runtime.cacheManager.get(
      `twitter/${username}/cookies`
    );
  }
  async cacheCookies(username, cookies) {
    await this.runtime.cacheManager.set(`twitter/${username}/cookies`, cookies);
  }
  async fetchProfile(username) {
    try {
      const profile = await this.requestQueue.add(async () => {
        var _a;
        const profile2 = await this.twitterClient.getProfile(username);
        return {
          id: profile2.userId,
          username,
          screenName: profile2.name || this.runtime.character.name,
          bio: profile2.biography || typeof this.runtime.character.bio === "string" ? this.runtime.character.bio : this.runtime.character.bio.length > 0 ? this.runtime.character.bio[0] : "",
          nicknames: ((_a = this.runtime.character.twitterProfile) == null ? void 0 : _a.nicknames) || []
        };
      });
      return profile;
    } catch (error) {
      console.error("Error fetching Twitter profile:", error);
      throw error;
    }
  }
};

// src/environment.ts
import {
  parseBooleanFromText,
  ActionTimelineType as ActionTimelineType2
} from "@elizaos/core";
import { z, ZodError } from "zod";
var DEFAULT_MAX_TWEET_LENGTH = 280;
var twitterUsernameSchema = z.string().min(1, "An X/Twitter Username must be at least 1 character long").max(15, "An X/Twitter Username cannot exceed 15 characters").refine((username) => {
  if (username === "*") return true;
  return /^[A-Za-z0-9_]+$/.test(username);
}, "An X Username can only contain letters, numbers, and underscores");
var twitterEnvSchema = z.object({
  TWITTER_DRY_RUN: z.boolean(),
  TWITTER_USERNAME: z.string().min(1, "X/Twitter username is required"),
  TWITTER_PASSWORD: z.string().min(1, "X/Twitter password is required"),
  TWITTER_EMAIL: z.string().email("Valid X/Twitter email is required"),
  MAX_TWEET_LENGTH: z.number().int().default(DEFAULT_MAX_TWEET_LENGTH),
  TWITTER_SEARCH_ENABLE: z.boolean().default(false),
  TWITTER_2FA_SECRET: z.string(),
  TWITTER_RETRY_LIMIT: z.number().int(),
  TWITTER_POLL_INTERVAL: z.number().int(),
  TWITTER_TARGET_USERS: z.array(twitterUsernameSchema).default([]),
  // I guess it's possible to do the transformation with zod
  // not sure it's preferable, maybe a readability issue
  // since more people will know js/ts than zod
  /*
        z
        .string()
        .transform((val) => val.trim())
        .pipe(
            z.string()
                .transform((val) =>
                    val ? val.split(',').map((u) => u.trim()).filter(Boolean) : []
                )
                .pipe(
                    z.array(
                        z.string()
                            .min(1)
                            .max(15)
                            .regex(
                                /^[A-Za-z][A-Za-z0-9_]*[A-Za-z0-9]$|^[A-Za-z]$/,
                                'Invalid Twitter username format'
                            )
                    )
                )
                .transform((users) => users.join(','))
        )
        .optional()
        .default(''),
    */
  ENABLE_TWITTER_POST_GENERATION: z.boolean(),
  POST_INTERVAL_MIN: z.number().int(),
  POST_INTERVAL_MAX: z.number().int(),
  ENABLE_ACTION_PROCESSING: z.boolean(),
  ACTION_INTERVAL: z.number().int(),
  POST_IMMEDIATELY: z.boolean(),
  TWITTER_SPACES_ENABLE: z.boolean().default(false),
  MAX_ACTIONS_PROCESSING: z.number().int(),
  ACTION_TIMELINE_TYPE: z.nativeEnum(ActionTimelineType2).default(ActionTimelineType2.ForYou)
});
function parseTargetUsers(targetUsersStr) {
  if (!(targetUsersStr == null ? void 0 : targetUsersStr.trim())) {
    return [];
  }
  return targetUsersStr.split(",").map((user) => user.trim()).filter(Boolean);
}
function safeParseInt(value, defaultValue) {
  if (!value) return defaultValue;
  const parsed = Number.parseInt(value, 10);
  return isNaN(parsed) ? defaultValue : Math.max(1, parsed);
}
async function validateTwitterConfig(runtime) {
  try {
    const twitterConfig = {
      TWITTER_DRY_RUN: parseBooleanFromText(
        runtime.getSetting("TWITTER_DRY_RUN") || process.env.TWITTER_DRY_RUN
      ) ?? false,
      // parseBooleanFromText return null if "", map "" to false
      TWITTER_USERNAME: runtime.getSetting("TWITTER_USERNAME") || process.env.TWITTER_USERNAME,
      TWITTER_PASSWORD: runtime.getSetting("TWITTER_PASSWORD") || process.env.TWITTER_PASSWORD,
      TWITTER_EMAIL: runtime.getSetting("TWITTER_EMAIL") || process.env.TWITTER_EMAIL,
      // number as string?
      MAX_TWEET_LENGTH: safeParseInt(
        runtime.getSetting("MAX_TWEET_LENGTH") || process.env.MAX_TWEET_LENGTH,
        DEFAULT_MAX_TWEET_LENGTH
      ),
      TWITTER_SEARCH_ENABLE: parseBooleanFromText(
        runtime.getSetting("TWITTER_SEARCH_ENABLE") || process.env.TWITTER_SEARCH_ENABLE
      ) ?? false,
      // string passthru
      TWITTER_2FA_SECRET: runtime.getSetting("TWITTER_2FA_SECRET") || process.env.TWITTER_2FA_SECRET || "",
      // int
      TWITTER_RETRY_LIMIT: safeParseInt(
        runtime.getSetting("TWITTER_RETRY_LIMIT") || process.env.TWITTER_RETRY_LIMIT,
        5
      ),
      // int in seconds
      TWITTER_POLL_INTERVAL: safeParseInt(
        runtime.getSetting("TWITTER_POLL_INTERVAL") || process.env.TWITTER_POLL_INTERVAL,
        120
        // 2m
      ),
      // comma separated string
      TWITTER_TARGET_USERS: parseTargetUsers(
        runtime.getSetting("TWITTER_TARGET_USERS") || process.env.TWITTER_TARGET_USERS
      ),
      // bool
      ENABLE_TWITTER_POST_GENERATION: parseBooleanFromText(
        runtime.getSetting("ENABLE_TWITTER_POST_GENERATION") || process.env.ENABLE_TWITTER_POST_GENERATION
      ) ?? true,
      // int in minutes
      POST_INTERVAL_MIN: safeParseInt(
        runtime.getSetting("POST_INTERVAL_MIN") || process.env.POST_INTERVAL_MIN,
        90
        // 1.5 hours
      ),
      // int in minutes
      POST_INTERVAL_MAX: safeParseInt(
        runtime.getSetting("POST_INTERVAL_MAX") || process.env.POST_INTERVAL_MAX,
        180
        // 3 hours
      ),
      // bool
      ENABLE_ACTION_PROCESSING: parseBooleanFromText(
        runtime.getSetting("ENABLE_ACTION_PROCESSING") || process.env.ENABLE_ACTION_PROCESSING
      ) ?? false,
      // init in minutes (min 1m)
      ACTION_INTERVAL: safeParseInt(
        runtime.getSetting("ACTION_INTERVAL") || process.env.ACTION_INTERVAL,
        5
        // 5 minutes
      ),
      // bool
      POST_IMMEDIATELY: parseBooleanFromText(
        runtime.getSetting("POST_IMMEDIATELY") || process.env.POST_IMMEDIATELY
      ) ?? false,
      TWITTER_SPACES_ENABLE: parseBooleanFromText(
        runtime.getSetting("TWITTER_SPACES_ENABLE") || process.env.TWITTER_SPACES_ENABLE
      ) ?? false,
      MAX_ACTIONS_PROCESSING: safeParseInt(
        runtime.getSetting("MAX_ACTIONS_PROCESSING") || process.env.MAX_ACTIONS_PROCESSING,
        1
      ),
      ACTION_TIMELINE_TYPE: runtime.getSetting("ACTION_TIMELINE_TYPE") || process.env.ACTION_TIMELINE_TYPE
    };
    return twitterEnvSchema.parse(twitterConfig);
  } catch (error) {
    if (error instanceof ZodError) {
      const errorMessages = error.errors.map((err) => `${err.path.join(".")}: ${err.message}`).join("\n");
      throw new Error(
        `X/Twitter configuration validation failed:
${errorMessages}`
      );
    }
    throw error;
  }
}

// src/interactions.ts
import { SearchMode as SearchMode2 } from "@flooz-link/agent-twitter-client";
import {
  composeContext,
  generateMessageResponse,
  generateShouldRespond,
  messageCompletionFooter,
  shouldRespondFooter,
  ModelClass,
  stringToUuid as stringToUuid3,
  elizaLogger as elizaLogger3,
  getEmbeddingZeroVector as getEmbeddingZeroVector3,
  ServiceType
} from "@elizaos/core";

// src/utils.ts
import { getEmbeddingZeroVector as getEmbeddingZeroVector2 } from "@elizaos/core";
import { stringToUuid as stringToUuid2 } from "@elizaos/core";
import { elizaLogger as elizaLogger2 } from "@elizaos/core";
import fs from "fs";
import path from "path";
var wait = (minTime = 1e3, maxTime = 3e3) => {
  const waitTime = Math.floor(Math.random() * (maxTime - minTime + 1)) + minTime;
  return new Promise((resolve) => setTimeout(resolve, waitTime));
};
function isNotEmpty(input) {
  return !isEmpty(input);
}
function isEmpty(input) {
  return input === void 0 || input === null || input === "";
}
async function buildConversationThread(tweet, client, maxReplies = 10) {
  const thread = [];
  const visited = /* @__PURE__ */ new Set();
  async function processThread(currentTweet, depth = 0) {
    var _a;
    elizaLogger2.debug("Processing tweet:", {
      id: currentTweet.id,
      inReplyToStatusId: currentTweet.inReplyToStatusId,
      depth
    });
    if (!currentTweet) {
      elizaLogger2.debug("No current tweet found for thread building");
      return;
    }
    if (depth >= maxReplies) {
      elizaLogger2.debug("Reached maximum reply depth", depth);
      return;
    }
    const memory = await client.runtime.messageManager.getMemoryById(
      stringToUuid2(currentTweet.id + "-" + client.runtime.agentId)
    );
    if (!memory) {
      const roomId = stringToUuid2(
        currentTweet.conversationId + "-" + client.runtime.agentId
      );
      const userId = stringToUuid2(currentTweet.userId);
      await client.runtime.ensureConnection(
        userId,
        roomId,
        currentTweet.username,
        currentTweet.name,
        "twitter"
      );
      await client.runtime.messageManager.createMemory({
        id: stringToUuid2(currentTweet.id + "-" + client.runtime.agentId),
        agentId: client.runtime.agentId,
        content: {
          text: currentTweet.text,
          source: "twitter",
          url: currentTweet.permanentUrl,
          imageUrls: currentTweet.photos.map((p) => p.url) || [],
          inReplyTo: currentTweet.inReplyToStatusId ? stringToUuid2(
            currentTweet.inReplyToStatusId + "-" + client.runtime.agentId
          ) : void 0
        },
        createdAt: currentTweet.timestamp * 1e3,
        roomId,
        userId: currentTweet.userId === client.profile.id ? client.runtime.agentId : stringToUuid2(currentTweet.userId),
        embedding: getEmbeddingZeroVector2()
      });
    }
    if (visited.has(currentTweet.id)) {
      elizaLogger2.debug("Already visited tweet:", currentTweet.id);
      return;
    }
    visited.add(currentTweet.id);
    thread.unshift(currentTweet);
    elizaLogger2.debug("Current thread state:", {
      length: thread.length,
      currentDepth: depth,
      tweetId: currentTweet.id
    });
    if (currentTweet.inReplyToStatusId) {
      elizaLogger2.debug(
        "Fetching parent tweet:",
        currentTweet.inReplyToStatusId
      );
      try {
        const parentTweet = await client.twitterClient.getTweet(
          currentTweet.inReplyToStatusId
        );
        if (parentTweet) {
          elizaLogger2.debug("Found parent tweet:", {
            id: parentTweet.id,
            text: (_a = parentTweet.text) == null ? void 0 : _a.slice(0, 50)
          });
          await processThread(parentTweet, depth + 1);
        } else {
          elizaLogger2.debug(
            "No parent tweet found for:",
            currentTweet.inReplyToStatusId
          );
        }
      } catch (error) {
        elizaLogger2.error("Error fetching parent tweet:", {
          tweetId: currentTweet.inReplyToStatusId,
          error
        });
      }
    } else {
      elizaLogger2.debug("Reached end of reply chain at:", currentTweet.id);
    }
  }
  await processThread(tweet, 0);
  elizaLogger2.debug("Final thread built:", {
    totalTweets: thread.length,
    tweetIds: thread.map((t) => {
      var _a;
      return {
        id: t.id,
        text: (_a = t.text) == null ? void 0 : _a.slice(0, 50)
      };
    })
  });
  return thread;
}
async function fetchMediaData(attachments) {
  return Promise.all(
    attachments.map(async (attachment) => {
      if (/^(http|https):\/\//.test(attachment.url)) {
        const response = await fetch(attachment.url);
        if (!response.ok) {
          throw new Error(`Failed to fetch file: ${attachment.url}`);
        }
        const mediaBuffer = Buffer.from(await response.arrayBuffer());
        const mediaType = attachment.contentType;
        return { data: mediaBuffer, mediaType };
      } else if (fs.existsSync(attachment.url)) {
        const mediaBuffer = await fs.promises.readFile(
          path.resolve(attachment.url)
        );
        const mediaType = attachment.contentType;
        return { data: mediaBuffer, mediaType };
      } else {
        throw new Error(
          `File not found: ${attachment.url}. Make sure the path is correct.`
        );
      }
    })
  );
}
async function sendTweet(client, content, roomId, twitterUsername, inReplyTo) {
  var _a, _b, _c, _d, _e, _f;
  const maxTweetLength = client.twitterConfig.MAX_TWEET_LENGTH;
  const isLongTweet = maxTweetLength > 280;
  const tweetChunks = splitTweetContent(content.text, maxTweetLength);
  const sentTweets = [];
  let previousTweetId = inReplyTo;
  for (const chunk of tweetChunks) {
    let mediaData = null;
    if (content.attachments && content.attachments.length > 0) {
      mediaData = await fetchMediaData(content.attachments);
    }
    const cleanChunk = deduplicateMentions(chunk.trim());
    const result = await client.requestQueue.add(
      async () => isLongTweet ? client.twitterClient.sendLongTweet(
        cleanChunk,
        previousTweetId,
        mediaData
      ) : client.twitterClient.sendTweet(
        cleanChunk,
        previousTweetId,
        mediaData
      )
    );
    const body = await result.json();
    const tweetResult = isLongTweet ? (_c = (_b = (_a = body == null ? void 0 : body.data) == null ? void 0 : _a.notetweet_create) == null ? void 0 : _b.tweet_results) == null ? void 0 : _c.result : (_f = (_e = (_d = body == null ? void 0 : body.data) == null ? void 0 : _d.create_tweet) == null ? void 0 : _e.tweet_results) == null ? void 0 : _f.result;
    if (tweetResult) {
      const finalTweet = {
        id: tweetResult.rest_id,
        text: tweetResult.legacy.full_text,
        conversationId: tweetResult.legacy.conversation_id_str,
        timestamp: new Date(tweetResult.legacy.created_at).getTime() / 1e3,
        userId: tweetResult.legacy.user_id_str,
        inReplyToStatusId: tweetResult.legacy.in_reply_to_status_id_str,
        permanentUrl: `https://twitter.com/${twitterUsername}/status/${tweetResult.rest_id}`,
        hashtags: [],
        mentions: [],
        photos: [],
        thread: [],
        urls: [],
        videos: []
      };
      sentTweets.push(finalTweet);
      previousTweetId = finalTweet.id;
    } else {
      elizaLogger2.error("Error sending tweet chunk:", {
        chunk,
        response: body
      });
    }
    await wait(1e3, 2e3);
  }
  const memories = sentTweets.map((tweet) => ({
    id: stringToUuid2(tweet.id + "-" + client.runtime.agentId),
    agentId: client.runtime.agentId,
    userId: client.runtime.agentId,
    content: {
      tweetId: tweet.id,
      text: tweet.text,
      source: "twitter",
      url: tweet.permanentUrl,
      imageUrls: tweet.photos.map((p) => p.url) || [],
      inReplyTo: tweet.inReplyToStatusId ? stringToUuid2(tweet.inReplyToStatusId + "-" + client.runtime.agentId) : void 0
    },
    roomId,
    embedding: getEmbeddingZeroVector2(),
    createdAt: tweet.timestamp * 1e3
  }));
  return memories;
}
function splitTweetContent(content, maxLength) {
  const paragraphs = content.split("\n\n").map((p) => p.trim());
  const tweets = [];
  let currentTweet = "";
  for (const paragraph of paragraphs) {
    if (!paragraph) continue;
    if ((currentTweet + "\n\n" + paragraph).trim().length <= maxLength) {
      if (currentTweet) {
        currentTweet += "\n\n" + paragraph;
      } else {
        currentTweet = paragraph;
      }
    } else {
      if (currentTweet) {
        tweets.push(currentTweet.trim());
      }
      if (paragraph.length <= maxLength) {
        currentTweet = paragraph;
      } else {
        const chunks = splitParagraph(paragraph, maxLength);
        tweets.push(...chunks.slice(0, -1));
        currentTweet = chunks[chunks.length - 1];
      }
    }
  }
  if (currentTweet) {
    tweets.push(currentTweet.trim());
  }
  return tweets;
}
function extractUrls(paragraph) {
  const urlRegex = /https?:\/\/[^\s]+/g;
  const placeholderMap = /* @__PURE__ */ new Map();
  let urlIndex = 0;
  const textWithPlaceholders = paragraph.replace(urlRegex, (match) => {
    const placeholder = `<<URL_CONSIDERER_23_${urlIndex}>>`;
    placeholderMap.set(placeholder, match);
    urlIndex++;
    return placeholder;
  });
  return { textWithPlaceholders, placeholderMap };
}
function splitSentencesAndWords(text, maxLength) {
  const sentences = text.match(/[^.!?]+[.!?]+|[^.!?]+$/g) || [text];
  const chunks = [];
  let currentChunk = "";
  for (const sentence of sentences) {
    if ((currentChunk + " " + sentence).trim().length <= maxLength) {
      if (currentChunk) {
        currentChunk += " " + sentence;
      } else {
        currentChunk = sentence;
      }
    } else {
      if (currentChunk) {
        chunks.push(currentChunk.trim());
      }
      if (sentence.length <= maxLength) {
        currentChunk = sentence;
      } else {
        const words = sentence.split(" ");
        currentChunk = "";
        for (const word of words) {
          if ((currentChunk + " " + word).trim().length <= maxLength) {
            if (currentChunk) {
              currentChunk += " " + word;
            } else {
              currentChunk = word;
            }
          } else {
            if (currentChunk) {
              chunks.push(currentChunk.trim());
            }
            currentChunk = word;
          }
        }
      }
    }
  }
  if (currentChunk) {
    chunks.push(currentChunk.trim());
  }
  return chunks;
}
function deduplicateMentions(paragraph) {
  const mentionRegex = /^@(\w+)(?:\s+@(\w+))*(\s+|$)/;
  const matches = paragraph.match(mentionRegex);
  if (!matches) {
    return paragraph;
  }
  let mentions = matches.slice(0, 1)[0].trim().split(" ");
  mentions = [...new Set(mentions)];
  const uniqueMentionsString = mentions.join(" ");
  const endOfMentions = paragraph.indexOf(matches[0]) + matches[0].length;
  return uniqueMentionsString + " " + paragraph.slice(endOfMentions);
}
function restoreUrls(chunks, placeholderMap) {
  return chunks.map((chunk) => {
    return chunk.replace(/<<URL_CONSIDERER_23_(\d+)>>/g, (match) => {
      const original = placeholderMap.get(match);
      return original || match;
    });
  });
}
function splitParagraph(paragraph, maxLength) {
  const { textWithPlaceholders, placeholderMap } = extractUrls(paragraph);
  const splittedChunks = splitSentencesAndWords(
    textWithPlaceholders,
    maxLength
  );
  const restoredChunks = restoreUrls(splittedChunks, placeholderMap);
  return restoredChunks;
}

// src/interactions.ts
var twitterMessageHandlerTemplate = `
# Areas of Expertise
{{knowledge}}

# About {{agentName}} (@{{twitterUserName}}):
{{bio}}
{{lore}}
{{topics}}

{{providers}}

{{characterPostExamples}}

{{postDirections}}

Recent interactions between {{agentName}} and other users:
{{recentPostInteractions}}

{{recentPosts}}

# TASK: Generate a post/reply in the voice, style and perspective of {{agentName}} (@{{twitterUserName}}) while using the thread of tweets as additional context:

Current Post:
{{currentPost}}
Here is the descriptions of images in the Current post.
{{imageDescriptions}}

Thread of Tweets You Are Replying To:
{{formattedConversation}}

# INSTRUCTIONS: Generate a post in the voice, style and perspective of {{agentName}} (@{{twitterUserName}}). You MUST include an action if the current post text includes a prompt that is similar to one of the available actions mentioned here:
{{actionNames}}
{{actions}}

Here is the current post text again. Remember to include an action if the current post text includes a prompt that asks for one of the available actions mentioned above (does not need to be exact)
{{currentPost}}
Here is the descriptions of images in the Current post.
{{imageDescriptions}}
` + messageCompletionFooter;
var twitterShouldRespondTemplate = (targetUsersStr) => `# INSTRUCTIONS: Determine if {{agentName}} (@{{twitterUserName}}) should respond to the message and participate in the conversation. Do not comment. Just respond with "true" or "false".

Response options are RESPOND, IGNORE and STOP.

PRIORITY RULE: ALWAYS RESPOND to these users regardless of topic or message content: ${targetUsersStr}. Topic relevance should be ignored for these users.

For other users:
- {{agentName}} should RESPOND to messages directed at them
- {{agentName}} should RESPOND to conversations relevant to their background
- {{agentName}} should IGNORE irrelevant messages
- {{agentName}} should IGNORE very short messages unless directly addressed
- {{agentName}} should STOP if asked to stop
- {{agentName}} should STOP if conversation is concluded
- {{agentName}} is in a room with other users and wants to be conversational, but not annoying.

IMPORTANT:
- {{agentName}} (aka @{{twitterUserName}}) is particularly sensitive about being annoying, so if there is any doubt, it is better to IGNORE than to RESPOND.
- For users not in the priority list, {{agentName}} (@{{twitterUserName}}) should err on the side of IGNORE rather than RESPOND if in doubt.

Recent Posts:
{{recentPosts}}

Current Post:
{{currentPost}}

Thread of Tweets You Are Replying To:
{{formattedConversation}}

# INSTRUCTIONS: Respond with [RESPOND] if {{agentName}} should respond, or [IGNORE] if {{agentName}} should not respond to the last message and [STOP] if {{agentName}} should stop participating in the conversation.
` + shouldRespondFooter;
var TwitterInteractionClient = class {
  client;
  runtime;
  isDryRun;
  constructor(client, runtime) {
    this.client = client;
    this.runtime = runtime;
    this.isDryRun = this.client.twitterConfig.TWITTER_DRY_RUN;
  }
  async start() {
    const handleTwitterInteractionsLoop = () => {
      this.handleTwitterInteractions();
      setTimeout(
        handleTwitterInteractionsLoop,
        // Defaults to 2 minutes
        this.client.twitterConfig.TWITTER_POLL_INTERVAL * 1e3
      );
    };
    handleTwitterInteractionsLoop();
  }
  async handleTwitterInteractions() {
    var _a, _b;
    elizaLogger3.log("Checking Twitter interactions");
    const twitterUsername = this.client.profile.username;
    try {
      const mentionCandidates = (await this.client.fetchSearchTweets(
        `@${twitterUsername}`,
        20,
        SearchMode2.Latest
      )).tweets;
      elizaLogger3.log(
        "Completed checking mentioned tweets:",
        mentionCandidates.length
      );
      let uniqueTweetCandidates = [...mentionCandidates];
      if (this.client.twitterConfig.TWITTER_TARGET_USERS.length) {
        const TARGET_USERS = this.client.twitterConfig.TWITTER_TARGET_USERS;
        elizaLogger3.log("Processing target users:", TARGET_USERS);
        if (TARGET_USERS.length > 0) {
          const tweetsByUser = /* @__PURE__ */ new Map();
          for (const username of TARGET_USERS) {
            try {
              const userTweets = (await this.client.twitterClient.fetchSearchTweets(
                `from:${username}`,
                3,
                SearchMode2.Latest
              )).tweets;
              const validTweets = userTweets.filter((tweet) => {
                const isUnprocessed = !this.client.lastCheckedTweetId || Number.parseInt(tweet.id) > this.client.lastCheckedTweetId;
                const isRecent = Date.now() - tweet.timestamp * 1e3 < 2 * 60 * 60 * 1e3;
                elizaLogger3.log(`Tweet ${tweet.id} checks:`, {
                  isUnprocessed,
                  isRecent,
                  isReply: tweet.isReply,
                  isRetweet: tweet.isRetweet
                });
                return isUnprocessed && !tweet.isReply && !tweet.isRetweet && isRecent;
              });
              if (validTweets.length > 0) {
                tweetsByUser.set(username, validTweets);
                elizaLogger3.log(
                  `Found ${validTweets.length} valid tweets from ${username}`
                );
              }
            } catch (error) {
              elizaLogger3.error(
                `Error fetching tweets for ${username}:`,
                error
              );
              continue;
            }
          }
          const selectedTweets = [];
          for (const [username, tweets] of tweetsByUser) {
            if (tweets.length > 0) {
              const randomTweet = tweets[Math.floor(Math.random() * tweets.length)];
              selectedTweets.push(randomTweet);
              elizaLogger3.log(
                `Selected tweet from ${username}: ${(_a = randomTweet.text) == null ? void 0 : _a.substring(0, 100)}`
              );
            }
          }
          uniqueTweetCandidates = [...mentionCandidates, ...selectedTweets];
        }
      } else {
        elizaLogger3.log("No target users configured, processing only mentions");
      }
      uniqueTweetCandidates.sort((a, b) => a.id.localeCompare(b.id)).filter((tweet) => tweet.userId !== this.client.profile.id);
      for (const tweet of uniqueTweetCandidates) {
        if (!this.client.lastCheckedTweetId || BigInt(tweet.id) > this.client.lastCheckedTweetId) {
          const tweetId = stringToUuid3(tweet.id + "-" + this.runtime.agentId);
          const existingResponse = await this.runtime.messageManager.getMemoryById(tweetId);
          if (existingResponse) {
            elizaLogger3.log(`Already responded to tweet ${tweet.id}, skipping`);
            continue;
          }
          elizaLogger3.log("New Tweet found", tweet.permanentUrl);
          const roomId = stringToUuid3(
            tweet.conversationId + "-" + this.runtime.agentId
          );
          const userIdUUID = tweet.userId === this.client.profile.id ? this.runtime.agentId : stringToUuid3(tweet.userId);
          await this.runtime.ensureConnection(
            userIdUUID,
            roomId,
            tweet.username,
            tweet.name,
            "twitter"
          );
          const thread = await buildConversationThread(tweet, this.client);
          const message = {
            content: {
              text: tweet.text,
              imageUrls: ((_b = tweet.photos) == null ? void 0 : _b.map((photo) => photo.url)) || []
            },
            agentId: this.runtime.agentId,
            userId: userIdUUID,
            roomId
          };
          await this.handleTweet({
            tweet,
            message,
            thread
          });
          this.client.lastCheckedTweetId = BigInt(tweet.id);
        }
      }
      await this.client.cacheLatestCheckedTweetId();
      elizaLogger3.log("Finished checking Twitter interactions");
    } catch (error) {
      elizaLogger3.error("Error handling Twitter interactions:", error);
    }
  }
  async handleTweet({
    tweet,
    message,
    thread
  }) {
    var _a, _b, _c, _d, _e, _f, _g, _h, _i;
    if (tweet.userId === this.client.profile.id && !this.client.twitterConfig.TWITTER_TARGET_USERS.includes(tweet.username)) {
      return;
    }
    if (!message.content.text) {
      elizaLogger3.log("Skipping Tweet with no text", tweet.id);
      return { text: "", action: "IGNORE" };
    }
    elizaLogger3.log("Processing Tweet: ", tweet.id);
    const formatTweet = (tweet2) => {
      return `  ID: ${tweet2.id}
  From: ${tweet2.name} (@${tweet2.username})
  Text: ${tweet2.text}`;
    };
    const currentPost = formatTweet(tweet);
    const formattedConversation = thread.map(
      (tweet2) => `@${tweet2.username} (${new Date(
        tweet2.timestamp * 1e3
      ).toLocaleString("en-US", {
        hour: "2-digit",
        minute: "2-digit",
        month: "short",
        day: "numeric"
      })}):
        ${tweet2.text}`
    ).join("\n\n");
    const imageDescriptionsArray = [];
    try {
      for (const photo of tweet.photos) {
        const description = await this.runtime.getService(ServiceType.IMAGE_DESCRIPTION).describeImage(photo.url);
        imageDescriptionsArray.push(description);
      }
    } catch (error) {
      elizaLogger3.error("Error Occured during describing image: ", error);
    }
    let state = await this.runtime.composeState(message, {
      twitterClient: this.client.twitterClient,
      twitterUserName: this.client.twitterConfig.TWITTER_USERNAME,
      currentPost,
      formattedConversation,
      imageDescriptions: imageDescriptionsArray.length > 0 ? `
Images in Tweet:
${imageDescriptionsArray.map(
        (desc, i) => `Image ${i + 1}: Title: ${desc.title}
Description: ${desc.description}`
      ).join("\n\n")}` : ""
    });
    const tweetId = stringToUuid3(tweet.id + "-" + this.runtime.agentId);
    const tweetExists = await this.runtime.messageManager.getMemoryById(tweetId);
    if (!tweetExists) {
      elizaLogger3.log("tweet does not exist, saving");
      const userIdUUID = stringToUuid3(tweet.userId);
      const roomId = stringToUuid3(tweet.conversationId);
      const message2 = {
        id: tweetId,
        agentId: this.runtime.agentId,
        content: {
          text: tweet.text,
          url: tweet.permanentUrl,
          imageUrls: ((_a = tweet.photos) == null ? void 0 : _a.map((photo) => photo.url)) || [],
          inReplyTo: tweet.inReplyToStatusId ? stringToUuid3(tweet.inReplyToStatusId + "-" + this.runtime.agentId) : void 0
        },
        userId: userIdUUID,
        roomId,
        createdAt: tweet.timestamp * 1e3
      };
      this.client.saveRequestMessage(message2, state);
    }
    const validTargetUsersStr = this.client.twitterConfig.TWITTER_TARGET_USERS.join(",");
    const shouldRespondContext = composeContext({
      state,
      template: ((_b = this.runtime.character.templates) == null ? void 0 : _b.twitterShouldRespondTemplate) || ((_d = (_c = this.runtime.character) == null ? void 0 : _c.templates) == null ? void 0 : _d.shouldRespondTemplate) || twitterShouldRespondTemplate(validTargetUsersStr)
    });
    const shouldRespond = await generateShouldRespond({
      runtime: this.runtime,
      context: shouldRespondContext,
      modelClass: ModelClass.MEDIUM
    });
    if (shouldRespond !== "RESPOND") {
      elizaLogger3.log("Not responding to message");
      return { text: "Response Decision:", action: shouldRespond };
    }
    const context = composeContext({
      state: {
        ...state,
        // Convert actionNames array to string
        actionNames: Array.isArray(state.actionNames) ? state.actionNames.join(", ") : state.actionNames || "",
        actions: Array.isArray(state.actions) ? state.actions.join("\n") : state.actions || "",
        // Ensure character examples are included
        characterPostExamples: this.runtime.character.messageExamples ? this.runtime.character.messageExamples.map(
          (example) => example.map(
            (msg) => `${msg.user}: ${msg.content.text}${msg.content.action ? ` [Action: ${msg.content.action}]` : ""}`
          ).join("\n")
        ).join("\n\n") : ""
      },
      template: ((_e = this.runtime.character.templates) == null ? void 0 : _e.twitterMessageHandlerTemplate) || ((_g = (_f = this.runtime.character) == null ? void 0 : _f.templates) == null ? void 0 : _g.messageHandlerTemplate) || twitterMessageHandlerTemplate
    });
    const response = await generateMessageResponse({
      runtime: this.runtime,
      context,
      modelClass: ModelClass.LARGE
    });
    const removeQuotes = (str) => str.replace(/^['"](.*)['"]$/, "$1");
    const stringId = stringToUuid3(tweet.id + "-" + this.runtime.agentId);
    response.inReplyTo = stringId;
    response.text = removeQuotes(response.text);
    if (response.text) {
      if (this.isDryRun) {
        elizaLogger3.info(
          `Dry run: Selected Post: ${tweet.id} - ${tweet.username}: ${tweet.text}
Agent's Output:
${response.text}`
        );
      } else {
        try {
          const callback = async (response2, tweetId2) => {
            const memories = await sendTweet(
              this.client,
              response2,
              message.roomId,
              this.client.twitterConfig.TWITTER_USERNAME,
              tweetId2 || tweet.id
            );
            return memories;
          };
          const action = this.runtime.actions.find(
            (a) => a.name === response.action
          );
          const shouldSuppressInitialMessage = action == null ? void 0 : action.suppressInitialMessage;
          let responseMessages = [];
          if (!shouldSuppressInitialMessage) {
            responseMessages = await callback(response);
          } else {
            responseMessages = [
              {
                id: stringToUuid3(tweet.id + "-" + this.runtime.agentId),
                userId: this.runtime.agentId,
                agentId: this.runtime.agentId,
                content: response,
                roomId: message.roomId,
                embedding: getEmbeddingZeroVector3(),
                createdAt: Date.now()
              }
            ];
          }
          state = await this.runtime.updateRecentMessageState(state);
          for (const responseMessage of responseMessages) {
            if (responseMessage === responseMessages[responseMessages.length - 1]) {
              responseMessage.content.action = response.action;
            } else {
              responseMessage.content.action = "CONTINUE";
            }
            await this.runtime.messageManager.createMemory(responseMessage);
          }
          const responseTweetId = (_i = (_h = responseMessages[responseMessages.length - 1]) == null ? void 0 : _h.content) == null ? void 0 : _i.tweetId;
          await this.runtime.processActions(
            message,
            responseMessages,
            state,
            (response2) => {
              return callback(response2, responseTweetId);
            }
          );
          const responseInfo = `Context:

${context}

Selected Post: ${tweet.id} - ${tweet.username}: ${tweet.text}
Agent's Output:
${response.text}`;
          await this.runtime.cacheManager.set(
            `twitter/tweet_generation_${tweet.id}.txt`,
            responseInfo
          );
          await wait();
        } catch (error) {
          elizaLogger3.error(`Error sending response tweet: ${error}`);
        }
      }
    }
  }
  async buildConversationThread(tweet, maxReplies = 10) {
    const thread = [];
    const visited = /* @__PURE__ */ new Set();
    async function processThread(currentTweet, depth = 0) {
      var _a, _b;
      elizaLogger3.log("Processing tweet:", {
        id: currentTweet.id,
        inReplyToStatusId: currentTweet.inReplyToStatusId,
        depth
      });
      if (!currentTweet) {
        elizaLogger3.log("No current tweet found for thread building");
        return;
      }
      if (depth >= maxReplies) {
        elizaLogger3.log("Reached maximum reply depth", depth);
        return;
      }
      const memory = await this.runtime.messageManager.getMemoryById(
        stringToUuid3(currentTweet.id + "-" + this.runtime.agentId)
      );
      if (!memory) {
        const roomId = stringToUuid3(
          currentTweet.conversationId + "-" + this.runtime.agentId
        );
        const userId = stringToUuid3(currentTweet.userId);
        await this.runtime.ensureConnection(
          userId,
          roomId,
          currentTweet.username,
          currentTweet.name,
          "twitter"
        );
        this.runtime.messageManager.createMemory({
          id: stringToUuid3(currentTweet.id + "-" + this.runtime.agentId),
          agentId: this.runtime.agentId,
          content: {
            text: currentTweet.text,
            source: "twitter",
            url: currentTweet.permanentUrl,
            imageUrls: ((_a = currentTweet.photos) == null ? void 0 : _a.map((photo) => photo.url)) || [],
            inReplyTo: currentTweet.inReplyToStatusId ? stringToUuid3(
              currentTweet.inReplyToStatusId + "-" + this.runtime.agentId
            ) : void 0
          },
          createdAt: currentTweet.timestamp * 1e3,
          roomId,
          userId: currentTweet.userId === this.twitterUserId ? this.runtime.agentId : stringToUuid3(currentTweet.userId),
          embedding: getEmbeddingZeroVector3()
        });
      }
      if (visited.has(currentTweet.id)) {
        elizaLogger3.log("Already visited tweet:", currentTweet.id);
        return;
      }
      visited.add(currentTweet.id);
      thread.unshift(currentTweet);
      if (currentTweet.inReplyToStatusId) {
        elizaLogger3.log(
          "Fetching parent tweet:",
          currentTweet.inReplyToStatusId
        );
        try {
          const parentTweet = await this.twitterClient.getTweet(
            currentTweet.inReplyToStatusId
          );
          if (parentTweet) {
            elizaLogger3.log("Found parent tweet:", {
              id: parentTweet.id,
              text: (_b = parentTweet.text) == null ? void 0 : _b.slice(0, 50)
            });
            await processThread(parentTweet, depth + 1);
          } else {
            elizaLogger3.log(
              "No parent tweet found for:",
              currentTweet.inReplyToStatusId
            );
          }
        } catch (error) {
          elizaLogger3.log("Error fetching parent tweet:", {
            tweetId: currentTweet.inReplyToStatusId,
            error
          });
        }
      } else {
        elizaLogger3.log("Reached end of reply chain at:", currentTweet.id);
      }
    }
    await processThread.bind(this)(tweet, 0);
    return thread;
  }
};

// src/post.ts
import {
  composeContext as composeContext2,
  generateText,
  getEmbeddingZeroVector as getEmbeddingZeroVector4,
  ModelClass as ModelClass2,
  stringToUuid as stringToUuid4,
  truncateToCompleteSentence,
  parseJSONObjectFromText,
  extractAttributes,
  cleanJsonResponse
} from "@elizaos/core";
import { elizaLogger as elizaLogger4 } from "@elizaos/core";
import { postActionResponseFooter } from "@elizaos/core";
import { generateTweetActions } from "@elizaos/core";
import { ServiceType as ServiceType2 } from "@elizaos/core";
import {
  Client,
  Events,
  GatewayIntentBits,
  TextChannel,
  Partials
} from "discord.js";
var MAX_TIMELINES_TO_FETCH = 15;
var twitterPostTemplate = `
# Areas of Expertise
{{knowledge}}

# About {{agentName}} (@{{twitterUserName}}):
{{bio}}
{{lore}}
{{topics}}

{{providers}}

{{characterPostExamples}}

{{postDirections}}

# Task: Generate a post in the voice and style and perspective of {{agentName}} @{{twitterUserName}}.
Write a post that is {{adjective}} about {{topic}} (without mentioning {{topic}} directly), from the perspective of {{agentName}}. Do not add commentary or acknowledge this request, just write the post.
Your response should be 1, 2, or 3 sentences (choose the length at random).
Your response should not contain any questions. Brief, concise statements only. The total character count MUST be less than {{maxTweetLength}}. No emojis. Use \\n\\n (double spaces) between statements if there are multiple statements in your response.`;
var twitterActionTemplate = `
# INSTRUCTIONS: Determine actions for {{agentName}} (@{{twitterUserName}}) based on:
{{bio}}
{{postDirections}}

Guidelines:
- ONLY engage with content that DIRECTLY relates to character's core interests
- Direct mentions are priority IF they are on-topic
- Skip ALL content that is:
  - Off-topic or tangentially related
  - From high-profile accounts unless explicitly relevant
  - Generic/viral content without specific relevance
  - Political/controversial unless central to character
  - Promotional/marketing unless directly relevant

Actions (respond only with tags):
[LIKE] - Perfect topic match AND aligns with character (9.8/10)
[RETWEET] - Exceptional content that embodies character's expertise (9.5/10)
[QUOTE] - Can add substantial domain expertise (9.5/10)
[REPLY] - Can contribute meaningful, expert-level insight (9.5/10)

Tweet:
{{currentTweet}}

# Respond with qualifying action tags only. Default to NO action unless extremely confident of relevance.` + postActionResponseFooter;
var TwitterPostClient = class {
  client;
  runtime;
  twitterUsername;
  isProcessing = false;
  lastProcessTime = 0;
  stopProcessingActions = false;
  isDryRun;
  discordClientForApproval;
  approvalRequired = false;
  discordApprovalChannelId;
  approvalCheckInterval;
  constructor(client, runtime) {
    var _a;
    this.client = client;
    this.runtime = runtime;
    this.twitterUsername = this.client.twitterConfig.TWITTER_USERNAME;
    this.isDryRun = this.client.twitterConfig.TWITTER_DRY_RUN;
    elizaLogger4.log("Twitter Client Configuration:");
    elizaLogger4.log(`- Username: ${this.twitterUsername}`);
    elizaLogger4.log(
      `- Dry Run Mode: ${this.isDryRun ? "enabled" : "disabled"}`
    );
    elizaLogger4.log(
      `- Enable Post: ${this.client.twitterConfig.ENABLE_TWITTER_POST_GENERATION ? "enabled" : "disabled"}`
    );
    elizaLogger4.log(
      `- Post Interval: ${this.client.twitterConfig.POST_INTERVAL_MIN}-${this.client.twitterConfig.POST_INTERVAL_MAX} minutes`
    );
    elizaLogger4.log(
      `- Action Processing: ${this.client.twitterConfig.ENABLE_ACTION_PROCESSING ? "enabled" : "disabled"}`
    );
    elizaLogger4.log(
      `- Action Interval: ${this.client.twitterConfig.ACTION_INTERVAL} minutes`
    );
    elizaLogger4.log(
      `- Post Immediately: ${this.client.twitterConfig.POST_IMMEDIATELY ? "enabled" : "disabled"}`
    );
    elizaLogger4.log(
      `- Search Enabled: ${this.client.twitterConfig.TWITTER_SEARCH_ENABLE ? "enabled" : "disabled"}`
    );
    const targetUsers = this.client.twitterConfig.TWITTER_TARGET_USERS;
    if (targetUsers) {
      elizaLogger4.log(`- Target Users: ${targetUsers}`);
    }
    if (this.isDryRun) {
      elizaLogger4.log(
        "Twitter client initialized in dry run mode - no actual tweets should be posted"
      );
    }
    const approvalRequired = ((_a = this.runtime.getSetting("TWITTER_APPROVAL_ENABLED")) == null ? void 0 : _a.toLocaleLowerCase()) === "true";
    if (approvalRequired) {
      const discordToken = this.runtime.getSetting(
        "TWITTER_APPROVAL_DISCORD_BOT_TOKEN"
      );
      const approvalChannelId = this.runtime.getSetting(
        "TWITTER_APPROVAL_DISCORD_CHANNEL_ID"
      );
      const APPROVAL_CHECK_INTERVAL = Number.parseInt(
        this.runtime.getSetting("TWITTER_APPROVAL_CHECK_INTERVAL")
      ) || 5 * 60 * 1e3;
      this.approvalCheckInterval = APPROVAL_CHECK_INTERVAL;
      if (!discordToken || !approvalChannelId) {
        throw new Error(
          "TWITTER_APPROVAL_DISCORD_BOT_TOKEN and TWITTER_APPROVAL_DISCORD_CHANNEL_ID are required for approval workflow"
        );
      }
      this.approvalRequired = true;
      this.discordApprovalChannelId = approvalChannelId;
      this.setupDiscordClient();
    }
  }
  setupDiscordClient() {
    this.discordClientForApproval = new Client({
      intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent,
        GatewayIntentBits.GuildMessageReactions
      ],
      partials: [Partials.Channel, Partials.Message, Partials.Reaction]
    });
    this.discordClientForApproval.once(Events.ClientReady, (readyClient) => {
      elizaLogger4.log(`Discord bot is ready as ${readyClient.user.tag}!`);
      const invite = `https://discord.com/api/oauth2/authorize?client_id=${readyClient.user.id}&permissions=274877991936&scope=bot`;
      elizaLogger4.log(
        `Use this link to properly invite the Twitter Post Approval Discord bot: ${invite}`
      );
    });
    this.discordClientForApproval.login(
      this.runtime.getSetting("TWITTER_APPROVAL_DISCORD_BOT_TOKEN")
    );
  }
  async start() {
    if (!this.client.profile) {
      await this.client.init();
    }
    const generateNewTweetLoop = async () => {
      const lastPost = await this.runtime.cacheManager.get("twitter/" + this.twitterUsername + "/lastPost");
      const lastPostTimestamp = (lastPost == null ? void 0 : lastPost.timestamp) ?? 0;
      const minMinutes = this.client.twitterConfig.POST_INTERVAL_MIN;
      const maxMinutes = this.client.twitterConfig.POST_INTERVAL_MAX;
      const randomMinutes = Math.floor(Math.random() * (maxMinutes - minMinutes + 1)) + minMinutes;
      const delay = randomMinutes * 60 * 1e3;
      if (Date.now() > lastPostTimestamp + delay) {
        await this.generateNewTweet();
      }
      setTimeout(() => {
        generateNewTweetLoop();
      }, delay);
      elizaLogger4.log(`Next tweet scheduled in ${randomMinutes} minutes`);
    };
    const processActionsLoop = async () => {
      const actionInterval = this.client.twitterConfig.ACTION_INTERVAL;
      while (!this.stopProcessingActions) {
        try {
          const results = await this.processTweetActions();
          if (results) {
            elizaLogger4.log(`Processed ${results.length} tweets`);
            elizaLogger4.log(
              `Next action processing scheduled in ${actionInterval} minutes`
            );
            await new Promise(
              (resolve) => setTimeout(resolve, actionInterval * 60 * 1e3)
              // now in minutes
            );
          }
        } catch (error) {
          elizaLogger4.error("Error in action processing loop:", error);
          await new Promise((resolve) => setTimeout(resolve, 3e4));
        }
      }
    };
    if (this.client.twitterConfig.POST_IMMEDIATELY) {
      await this.generateNewTweet();
    }
    if (this.client.twitterConfig.ENABLE_TWITTER_POST_GENERATION) {
      generateNewTweetLoop();
      elizaLogger4.log("Tweet generation loop started");
    }
    if (this.client.twitterConfig.ENABLE_ACTION_PROCESSING) {
      processActionsLoop().catch((error) => {
        elizaLogger4.error("Fatal error in process actions loop:", error);
      });
    }
    if (this.approvalRequired) this.runPendingTweetCheckLoop();
  }
  runPendingTweetCheckLoop() {
    setInterval(async () => {
      await this.handlePendingTweet();
    }, this.approvalCheckInterval);
  }
  createTweetObject(tweetResult, client, twitterUsername) {
    return {
      id: tweetResult.rest_id,
      name: client.profile.screenName,
      username: client.profile.username,
      text: tweetResult.legacy.full_text,
      conversationId: tweetResult.legacy.conversation_id_str,
      createdAt: tweetResult.legacy.created_at,
      timestamp: new Date(tweetResult.legacy.created_at).getTime(),
      userId: client.profile.id,
      inReplyToStatusId: tweetResult.legacy.in_reply_to_status_id_str,
      permanentUrl: `https://twitter.com/${twitterUsername}/status/${tweetResult.rest_id}`,
      hashtags: [],
      mentions: [],
      photos: [],
      thread: [],
      urls: [],
      videos: []
    };
  }
  async processAndCacheTweet(runtime, client, tweet, roomId, rawTweetContent) {
    await runtime.cacheManager.set(
      `twitter/${client.profile.username}/lastPost`,
      {
        id: tweet.id,
        timestamp: Date.now()
      }
    );
    await client.cacheTweet(tweet);
    elizaLogger4.log(`Tweet posted:
 ${tweet.permanentUrl}`);
    await runtime.ensureRoomExists(roomId);
    await runtime.ensureParticipantInRoom(runtime.agentId, roomId);
    await runtime.messageManager.createMemory({
      id: stringToUuid4(tweet.id + "-" + runtime.agentId),
      userId: runtime.agentId,
      agentId: runtime.agentId,
      content: {
        text: rawTweetContent.trim(),
        url: tweet.permanentUrl,
        source: "twitter"
      },
      roomId,
      embedding: getEmbeddingZeroVector4(),
      createdAt: tweet.timestamp
    });
  }
  async handleNoteTweet(client, content, tweetId, mediaData) {
    try {
      const noteTweetResult = await client.requestQueue.add(
        async () => await client.twitterClient.sendNoteTweet(content, tweetId, mediaData)
      );
      if (noteTweetResult.errors && noteTweetResult.errors.length > 0) {
        const truncateContent = truncateToCompleteSentence(
          content,
          this.client.twitterConfig.MAX_TWEET_LENGTH
        );
        return await this.sendStandardTweet(client, truncateContent, tweetId);
      } else {
        return noteTweetResult.data.notetweet_create.tweet_results.result;
      }
    } catch (error) {
      throw new Error(`Note Tweet failed: ${error}`);
    }
  }
  async sendStandardTweet(client, content, tweetId, mediaData) {
    var _a, _b, _c;
    try {
      const standardTweetResult = await client.requestQueue.add(
        async () => await client.twitterClient.sendTweet(content, tweetId, mediaData)
      );
      const body = await standardTweetResult.json();
      if (!((_c = (_b = (_a = body == null ? void 0 : body.data) == null ? void 0 : _a.create_tweet) == null ? void 0 : _b.tweet_results) == null ? void 0 : _c.result)) {
        elizaLogger4.error("Error sending tweet; Bad response:", body);
        return;
      }
      return body.data.create_tweet.tweet_results.result;
    } catch (error) {
      elizaLogger4.error("Error sending standard Tweet:", error);
      throw error;
    }
  }
  async postTweet(runtime, client, tweetTextForPosting, roomId, rawTweetContent, twitterUsername, mediaData) {
    try {
      elizaLogger4.log(`Posting new tweet:
`);
      let result;
      if (tweetTextForPosting.length > DEFAULT_MAX_TWEET_LENGTH) {
        result = await this.handleNoteTweet(
          client,
          tweetTextForPosting,
          void 0,
          mediaData
        );
      } else {
        result = await this.sendStandardTweet(
          client,
          tweetTextForPosting,
          void 0,
          mediaData
        );
      }
      const tweet = this.createTweetObject(result, client, twitterUsername);
      await this.processAndCacheTweet(
        runtime,
        client,
        tweet,
        roomId,
        rawTweetContent
      );
    } catch (error) {
      elizaLogger4.error("Error sending tweet:", error);
    }
  }
  /**
   * Generates and posts a new tweet. If isDryRun is true, only logs what would have been posted.
   */
  async generateNewTweet() {
    var _a;
    elizaLogger4.log("Generating new tweet");
    try {
      const roomId = stringToUuid4(
        "twitter_generate_room-" + this.client.profile.username
      );
      await this.runtime.ensureUserExists(
        this.runtime.agentId,
        this.client.profile.username,
        this.runtime.character.name,
        "twitter"
      );
      const topics = this.runtime.character.topics.join(", ");
      const maxTweetLength = this.client.twitterConfig.MAX_TWEET_LENGTH;
      const state = await this.runtime.composeState(
        {
          userId: this.runtime.agentId,
          roomId,
          agentId: this.runtime.agentId,
          content: {
            text: topics || "",
            action: "TWEET"
          }
        },
        {
          twitterUserName: this.client.profile.username,
          maxTweetLength
        }
      );
      const context = composeContext2({
        state,
        template: ((_a = this.runtime.character.templates) == null ? void 0 : _a.twitterPostTemplate) || twitterPostTemplate
      });
      elizaLogger4.debug("generate post prompt:\n" + context);
      const response = await generateText({
        runtime: this.runtime,
        context,
        modelClass: ModelClass2.SMALL
      });
      const rawTweetContent = cleanJsonResponse(response);
      let tweetTextForPosting = null;
      let mediaData = null;
      const parsedResponse = parseJSONObjectFromText(rawTweetContent);
      if (parsedResponse == null ? void 0 : parsedResponse.text) {
        tweetTextForPosting = parsedResponse.text;
      } else {
        tweetTextForPosting = rawTweetContent.trim();
      }
      if ((parsedResponse == null ? void 0 : parsedResponse.attachments) && (parsedResponse == null ? void 0 : parsedResponse.attachments.length) > 0) {
        mediaData = await fetchMediaData(parsedResponse.attachments);
      }
      if (!tweetTextForPosting) {
        const parsingText = extractAttributes(rawTweetContent, ["text"]).text;
        if (parsingText) {
          tweetTextForPosting = truncateToCompleteSentence(
            extractAttributes(rawTweetContent, ["text"]).text,
            this.client.twitterConfig.MAX_TWEET_LENGTH
          );
        }
      }
      if (!tweetTextForPosting) {
        tweetTextForPosting = rawTweetContent;
      }
      if (maxTweetLength) {
        tweetTextForPosting = truncateToCompleteSentence(
          tweetTextForPosting,
          maxTweetLength
        );
      }
      const removeQuotes = (str) => str.replace(/^['"](.*)['"]$/, "$1");
      const fixNewLines = (str) => str.replaceAll(/\\n/g, "\n\n");
      tweetTextForPosting = removeQuotes(fixNewLines(tweetTextForPosting));
      if (this.isDryRun) {
        elizaLogger4.info(
          `Dry run: would have posted tweet: ${tweetTextForPosting}`
        );
        return;
      }
      try {
        if (this.approvalRequired) {
          elizaLogger4.log(
            `Sending Tweet For Approval:
 ${tweetTextForPosting}`
          );
          await this.sendForApproval(
            tweetTextForPosting,
            roomId,
            rawTweetContent
          );
          elizaLogger4.log("Tweet sent for approval");
        } else {
          elizaLogger4.log(`Posting new tweet:
 ${tweetTextForPosting}`);
          this.postTweet(
            this.runtime,
            this.client,
            tweetTextForPosting,
            roomId,
            rawTweetContent,
            this.twitterUsername,
            mediaData
          );
        }
      } catch (error) {
        elizaLogger4.error("Error sending tweet:", error);
      }
    } catch (error) {
      elizaLogger4.error("Error generating new tweet:", error);
    }
  }
  async generateTweetContent(tweetState, options) {
    var _a;
    const context = composeContext2({
      state: tweetState,
      template: (options == null ? void 0 : options.template) || ((_a = this.runtime.character.templates) == null ? void 0 : _a.twitterPostTemplate) || twitterPostTemplate
    });
    const response = await generateText({
      runtime: this.runtime,
      context: (options == null ? void 0 : options.context) || context,
      modelClass: ModelClass2.SMALL
    });
    elizaLogger4.log("generate tweet content response:\n" + response);
    const cleanedResponse = cleanJsonResponse(response);
    const jsonResponse = parseJSONObjectFromText(cleanedResponse);
    if (jsonResponse.text) {
      const truncateContent2 = truncateToCompleteSentence(
        jsonResponse.text,
        this.client.twitterConfig.MAX_TWEET_LENGTH
      );
      return truncateContent2;
    }
    if (typeof jsonResponse === "object") {
      const possibleContent = jsonResponse.content || jsonResponse.message || jsonResponse.response;
      if (possibleContent) {
        const truncateContent2 = truncateToCompleteSentence(
          possibleContent,
          this.client.twitterConfig.MAX_TWEET_LENGTH
        );
        return truncateContent2;
      }
    }
    let truncateContent = null;
    const parsingText = extractAttributes(cleanedResponse, ["text"]).text;
    if (parsingText) {
      truncateContent = truncateToCompleteSentence(
        parsingText,
        this.client.twitterConfig.MAX_TWEET_LENGTH
      );
    }
    if (!truncateContent) {
      truncateContent = truncateToCompleteSentence(
        cleanedResponse,
        this.client.twitterConfig.MAX_TWEET_LENGTH
      );
    }
    return truncateContent;
  }
  /**
   * Processes tweet actions (likes, retweets, quotes, replies). If isDryRun is true,
   * only simulates and logs actions without making API calls.
   */
  async processTweetActions() {
    var _a;
    if (this.isProcessing) {
      elizaLogger4.log("Already processing tweet actions, skipping");
      return null;
    }
    try {
      this.isProcessing = true;
      this.lastProcessTime = Date.now();
      elizaLogger4.log("Processing tweet actions");
      await this.runtime.ensureUserExists(
        this.runtime.agentId,
        this.twitterUsername,
        this.runtime.character.name,
        "twitter"
      );
      const timelines = await this.client.fetchTimelineForActions(
        MAX_TIMELINES_TO_FETCH
      );
      const maxActionsProcessing = this.client.twitterConfig.MAX_ACTIONS_PROCESSING;
      const processedTimelines = [];
      for (const tweet of timelines) {
        try {
          const memory = await this.runtime.messageManager.getMemoryById(
            stringToUuid4(tweet.id + "-" + this.runtime.agentId)
          );
          if (memory) {
            elizaLogger4.log(`Already processed tweet ID: ${tweet.id}`);
            continue;
          }
          const roomId = stringToUuid4(
            tweet.conversationId + "-" + this.runtime.agentId
          );
          const tweetState = await this.runtime.composeState(
            {
              userId: this.runtime.agentId,
              roomId,
              agentId: this.runtime.agentId,
              content: { text: "", action: "" }
            },
            {
              twitterUserName: this.twitterUsername,
              currentTweet: `ID: ${tweet.id}
From: ${tweet.name} (@${tweet.username})
Text: ${tweet.text}`
            }
          );
          const actionContext = composeContext2({
            state: tweetState,
            template: ((_a = this.runtime.character.templates) == null ? void 0 : _a.twitterActionTemplate) || twitterActionTemplate
          });
          const actionResponse = await generateTweetActions({
            runtime: this.runtime,
            context: actionContext,
            modelClass: ModelClass2.SMALL
          });
          if (!actionResponse) {
            elizaLogger4.log(`No valid actions generated for tweet ${tweet.id}`);
            continue;
          }
          processedTimelines.push({
            tweet,
            actionResponse,
            tweetState,
            roomId
          });
        } catch (error) {
          elizaLogger4.error(`Error processing tweet ${tweet.id}:`, error);
          continue;
        }
      }
      const sortProcessedTimeline = (arr) => {
        return arr.sort((a, b) => {
          const countTrue = (obj) => Object.values(obj).filter(Boolean).length;
          const countA = countTrue(a.actionResponse);
          const countB = countTrue(b.actionResponse);
          if (countA !== countB) {
            return countB - countA;
          }
          if (a.actionResponse.like !== b.actionResponse.like) {
            return a.actionResponse.like ? -1 : 1;
          }
          return 0;
        });
      };
      const sortedTimelines = sortProcessedTimeline(processedTimelines).slice(
        0,
        maxActionsProcessing
      );
      return this.processTimelineActions(sortedTimelines);
    } catch (error) {
      elizaLogger4.error("Error in processTweetActions:", error);
      throw error;
    } finally {
      this.isProcessing = false;
    }
  }
  /**
   * Processes a list of timelines by executing the corresponding tweet actions.
   * Each timeline includes the tweet, action response, tweet state, and room context.
   * Results are returned for tracking completed actions.
   *
   * @param timelines - Array of objects containing tweet details, action responses, and state information.
   * @returns A promise that resolves to an array of results with details of executed actions.
   */
  async processTimelineActions(timelines) {
    var _a, _b, _c, _d, _e;
    const results = [];
    for (const timeline of timelines) {
      const { actionResponse, tweetState, roomId, tweet } = timeline;
      try {
        const executedActions = [];
        if (actionResponse.like) {
          if (this.isDryRun) {
            elizaLogger4.info(`Dry run: would have liked tweet ${tweet.id}`);
            executedActions.push("like (dry run)");
          } else {
            try {
              await this.client.twitterClient.likeTweet(tweet.id);
              executedActions.push("like");
              elizaLogger4.log(`Liked tweet ${tweet.id}`);
            } catch (error) {
              elizaLogger4.error(`Error liking tweet ${tweet.id}:`, error);
            }
          }
        }
        if (actionResponse.retweet) {
          if (this.isDryRun) {
            elizaLogger4.info(`Dry run: would have retweeted tweet ${tweet.id}`);
            executedActions.push("retweet (dry run)");
          } else {
            try {
              await this.client.twitterClient.retweet(tweet.id);
              executedActions.push("retweet");
              elizaLogger4.log(`Retweeted tweet ${tweet.id}`);
            } catch (error) {
              elizaLogger4.error(`Error retweeting tweet ${tweet.id}:`, error);
            }
          }
        }
        if (actionResponse.quote) {
          try {
            const thread = await buildConversationThread(tweet, this.client);
            const formattedConversation = thread.map(
              (t) => `@${t.username} (${new Date(
                t.timestamp * 1e3
              ).toLocaleString()}): ${t.text}`
            ).join("\n\n");
            const imageDescriptions = [];
            if (((_a = tweet.photos) == null ? void 0 : _a.length) > 0) {
              elizaLogger4.log("Processing images in tweet for context");
              for (const photo of tweet.photos) {
                const description = await this.runtime.getService(
                  ServiceType2.IMAGE_DESCRIPTION
                ).describeImage(photo.url);
                imageDescriptions.push(description);
              }
            }
            let quotedContent = "";
            if (tweet.quotedStatusId) {
              try {
                const quotedTweet = await this.client.twitterClient.getTweet(
                  tweet.quotedStatusId
                );
                if (quotedTweet) {
                  quotedContent = `
Quoted Tweet from @${quotedTweet.username}:
${quotedTweet.text}`;
                }
              } catch (error) {
                elizaLogger4.error("Error fetching quoted tweet:", error);
              }
            }
            const enrichedState = await this.runtime.composeState(
              {
                userId: this.runtime.agentId,
                roomId: stringToUuid4(
                  tweet.conversationId + "-" + this.runtime.agentId
                ),
                agentId: this.runtime.agentId,
                content: {
                  text: tweet.text,
                  action: "QUOTE"
                }
              },
              {
                twitterUserName: this.twitterUsername,
                currentPost: `From @${tweet.username}: ${tweet.text}`,
                formattedConversation,
                imageContext: imageDescriptions.length > 0 ? `
Images in Tweet:
${imageDescriptions.map((desc, i) => `Image ${i + 1}: ${desc}`).join("\n")}` : "",
                quotedContent
              }
            );
            const quoteContent = await this.generateTweetContent(
              enrichedState,
              {
                template: ((_b = this.runtime.character.templates) == null ? void 0 : _b.twitterMessageHandlerTemplate) || twitterMessageHandlerTemplate
              }
            );
            if (!quoteContent) {
              elizaLogger4.error("Failed to generate valid quote tweet content");
              return;
            }
            elizaLogger4.log("Generated quote tweet content:", quoteContent);
            if (this.isDryRun) {
              elizaLogger4.info(
                `Dry run: A quote tweet for tweet ID ${tweet.id} would have been posted with the following content: "${quoteContent}".`
              );
              executedActions.push("quote (dry run)");
            } else {
              const result = await this.client.requestQueue.add(
                async () => await this.client.twitterClient.sendQuoteTweet(
                  quoteContent,
                  tweet.id
                )
              );
              const body = await result.json();
              if ((_e = (_d = (_c = body == null ? void 0 : body.data) == null ? void 0 : _c.create_tweet) == null ? void 0 : _d.tweet_results) == null ? void 0 : _e.result) {
                elizaLogger4.log("Successfully posted quote tweet");
                executedActions.push("quote");
                await this.runtime.cacheManager.set(
                  `twitter/quote_generation_${tweet.id}.txt`,
                  `Context:
${enrichedState}

Generated Quote:
${quoteContent}`
                );
              } else {
                elizaLogger4.error("Quote tweet creation failed:", body);
              }
            }
          } catch (error) {
            elizaLogger4.error("Error in quote tweet generation:", error);
          }
        }
        if (actionResponse.reply) {
          try {
            await this.handleTextOnlyReply(tweet, tweetState, executedActions);
          } catch (error) {
            elizaLogger4.error(`Error replying to tweet ${tweet.id}:`, error);
          }
        }
        await this.runtime.ensureRoomExists(roomId);
        await this.runtime.ensureUserExists(
          stringToUuid4(tweet.userId),
          tweet.username,
          tweet.name,
          "twitter"
        );
        await this.runtime.ensureParticipantInRoom(
          this.runtime.agentId,
          roomId
        );
        if (!this.isDryRun) {
          await this.runtime.messageManager.createMemory({
            id: stringToUuid4(tweet.id + "-" + this.runtime.agentId),
            userId: stringToUuid4(tweet.userId),
            content: {
              text: tweet.text,
              url: tweet.permanentUrl,
              source: "twitter",
              action: executedActions.join(",")
            },
            agentId: this.runtime.agentId,
            roomId,
            embedding: getEmbeddingZeroVector4(),
            createdAt: tweet.timestamp * 1e3
          });
        }
        results.push({
          tweetId: tweet.id,
          actionResponse,
          executedActions
        });
      } catch (error) {
        elizaLogger4.error(`Error processing tweet ${tweet.id}:`, error);
        continue;
      }
    }
    return results;
  }
  /**
   * Handles text-only replies to tweets. If isDryRun is true, only logs what would
   * have been replied without making API calls.
   */
  async handleTextOnlyReply(tweet, tweetState, executedActions) {
    var _a, _b;
    try {
      const thread = await buildConversationThread(tweet, this.client);
      const formattedConversation = thread.map(
        (t) => `@${t.username} (${new Date(
          t.timestamp * 1e3
        ).toLocaleString()}): ${t.text}`
      ).join("\n\n");
      const imageDescriptions = [];
      if (((_a = tweet.photos) == null ? void 0 : _a.length) > 0) {
        elizaLogger4.log("Processing images in tweet for context");
        for (const photo of tweet.photos) {
          const description = await this.runtime.getService(ServiceType2.IMAGE_DESCRIPTION).describeImage(photo.url);
          imageDescriptions.push(description);
        }
      }
      let quotedContent = "";
      if (tweet.quotedStatusId) {
        try {
          const quotedTweet = await this.client.twitterClient.getTweet(
            tweet.quotedStatusId
          );
          if (quotedTweet) {
            quotedContent = `
Quoted Tweet from @${quotedTweet.username}:
${quotedTweet.text}`;
          }
        } catch (error) {
          elizaLogger4.error("Error fetching quoted tweet:", error);
        }
      }
      const enrichedState = await this.runtime.composeState(
        {
          userId: this.runtime.agentId,
          roomId: stringToUuid4(
            tweet.conversationId + "-" + this.runtime.agentId
          ),
          agentId: this.runtime.agentId,
          content: { text: tweet.text, action: "" }
        },
        {
          twitterUserName: this.twitterUsername,
          currentPost: `From @${tweet.username}: ${tweet.text}`,
          formattedConversation,
          imageContext: imageDescriptions.length > 0 ? `
Images in Tweet:
${imageDescriptions.map((desc, i) => `Image ${i + 1}: ${desc}`).join("\n")}` : "",
          quotedContent
        }
      );
      const replyText = await this.generateTweetContent(enrichedState, {
        template: ((_b = this.runtime.character.templates) == null ? void 0 : _b.twitterMessageHandlerTemplate) || twitterMessageHandlerTemplate
      });
      if (!replyText) {
        elizaLogger4.error("Failed to generate valid reply content");
        return;
      }
      if (this.isDryRun) {
        elizaLogger4.info(
          `Dry run: reply to tweet ${tweet.id} would have been: ${replyText}`
        );
        executedActions.push("reply (dry run)");
        return;
      }
      elizaLogger4.debug("Final reply text to be sent:", replyText);
      let result;
      if (replyText.length > DEFAULT_MAX_TWEET_LENGTH) {
        result = await this.handleNoteTweet(this.client, replyText, tweet.id);
      } else {
        result = await this.sendStandardTweet(this.client, replyText, tweet.id);
      }
      if (result) {
        elizaLogger4.log("Successfully posted reply tweet");
        executedActions.push("reply");
        await this.runtime.cacheManager.set(
          `twitter/reply_generation_${tweet.id}.txt`,
          `Context:
${enrichedState}

Generated Reply:
${replyText}`
        );
      } else {
        elizaLogger4.error("Tweet reply creation failed");
      }
    } catch (error) {
      elizaLogger4.error("Error in handleTextOnlyReply:", error);
    }
  }
  async stop() {
    this.stopProcessingActions = true;
  }
  async sendForApproval(tweetTextForPosting, roomId, rawTweetContent) {
    try {
      const embed = {
        title: "New Tweet Pending Approval",
        description: tweetTextForPosting,
        fields: [
          {
            name: "Character",
            value: this.client.profile.username,
            inline: true
          },
          {
            name: "Length",
            value: tweetTextForPosting.length.toString(),
            inline: true
          }
        ],
        footer: {
          text: "Reply with '\u{1F44D}' to post or '\u274C' to discard, This will automatically expire and remove after 24 hours if no response received"
        },
        timestamp: (/* @__PURE__ */ new Date()).toISOString()
      };
      const channel = await this.discordClientForApproval.channels.fetch(
        this.discordApprovalChannelId
      );
      if (!channel || !(channel instanceof TextChannel)) {
        throw new Error("Invalid approval channel");
      }
      const message = await channel.send({ embeds: [embed] });
      const pendingTweetsKey = `twitter/${this.client.profile.username}/pendingTweet`;
      const currentPendingTweets = await this.runtime.cacheManager.get(
        pendingTweetsKey
      ) || [];
      currentPendingTweets.push({
        tweetTextForPosting,
        roomId,
        rawTweetContent,
        discordMessageId: message.id,
        channelId: this.discordApprovalChannelId,
        timestamp: Date.now()
      });
      await this.runtime.cacheManager.set(
        pendingTweetsKey,
        currentPendingTweets
      );
      return message.id;
    } catch (error) {
      elizaLogger4.error("Error Sending Twitter Post Approval Request:", error);
      return null;
    }
  }
  async checkApprovalStatus(discordMessageId) {
    try {
      const channel = await this.discordClientForApproval.channels.fetch(
        this.discordApprovalChannelId
      );
      elizaLogger4.log(`channel ${JSON.stringify(channel)}`);
      if (!(channel instanceof TextChannel)) {
        elizaLogger4.error("Invalid approval channel");
        return "PENDING";
      }
      const message = await channel.messages.fetch(discordMessageId);
      const thumbsUpReaction = message.reactions.cache.find(
        (reaction) => reaction.emoji.name === "\u{1F44D}"
      );
      const rejectReaction = message.reactions.cache.find(
        (reaction) => reaction.emoji.name === "\u274C"
      );
      if (rejectReaction) {
        const count = rejectReaction.count;
        if (count > 0) {
          return "REJECTED";
        }
      }
      if (thumbsUpReaction) {
        const count = thumbsUpReaction.count;
        if (count > 0) {
          return "APPROVED";
        }
      }
      return "PENDING";
    } catch (error) {
      elizaLogger4.error("Error checking approval status:", error);
      return "PENDING";
    }
  }
  async cleanupPendingTweet(discordMessageId) {
    const pendingTweetsKey = `twitter/${this.client.profile.username}/pendingTweet`;
    const currentPendingTweets = await this.runtime.cacheManager.get(pendingTweetsKey) || [];
    const updatedPendingTweets = currentPendingTweets.filter(
      (tweet) => tweet.discordMessageId !== discordMessageId
    );
    if (updatedPendingTweets.length === 0) {
      await this.runtime.cacheManager.delete(pendingTweetsKey);
    } else {
      await this.runtime.cacheManager.set(
        pendingTweetsKey,
        updatedPendingTweets
      );
    }
  }
  async handlePendingTweet() {
    elizaLogger4.log("Checking Pending Tweets...");
    const pendingTweetsKey = `twitter/${this.client.profile.username}/pendingTweet`;
    const pendingTweets = await this.runtime.cacheManager.get(pendingTweetsKey) || [];
    for (const pendingTweet of pendingTweets) {
      const isExpired = Date.now() - pendingTweet.timestamp > 24 * 60 * 60 * 1e3;
      if (isExpired) {
        elizaLogger4.log("Pending tweet expired, cleaning up");
        try {
          const channel = await this.discordClientForApproval.channels.fetch(
            pendingTweet.channelId
          );
          if (channel instanceof TextChannel) {
            const originalMessage = await channel.messages.fetch(
              pendingTweet.discordMessageId
            );
            await originalMessage.reply(
              "This tweet approval request has expired (24h timeout)."
            );
          }
        } catch (error) {
          elizaLogger4.error("Error sending expiration notification:", error);
        }
        await this.cleanupPendingTweet(pendingTweet.discordMessageId);
        return;
      }
      elizaLogger4.log("Checking approval status...");
      const approvalStatus = await this.checkApprovalStatus(pendingTweet.discordMessageId);
      if (approvalStatus === "APPROVED") {
        elizaLogger4.log("Tweet Approved, Posting");
        await this.postTweet(
          this.runtime,
          this.client,
          pendingTweet.tweetTextForPosting,
          pendingTweet.roomId,
          pendingTweet.rawTweetContent,
          this.twitterUsername
        );
        try {
          const channel = await this.discordClientForApproval.channels.fetch(
            pendingTweet.channelId
          );
          if (channel instanceof TextChannel) {
            const originalMessage = await channel.messages.fetch(
              pendingTweet.discordMessageId
            );
            await originalMessage.reply(
              "Tweet has been posted successfully! \u2705"
            );
          }
        } catch (error) {
          elizaLogger4.error("Error sending post notification:", error);
        }
        await this.cleanupPendingTweet(pendingTweet.discordMessageId);
      } else if (approvalStatus === "REJECTED") {
        elizaLogger4.log("Tweet Rejected, Cleaning Up");
        await this.cleanupPendingTweet(pendingTweet.discordMessageId);
        try {
          const channel = await this.discordClientForApproval.channels.fetch(
            pendingTweet.channelId
          );
          if (channel instanceof TextChannel) {
            const originalMessage = await channel.messages.fetch(
              pendingTweet.discordMessageId
            );
            await originalMessage.reply("Tweet has been rejected! \u274C");
          }
        } catch (error) {
          elizaLogger4.error("Error sending rejection notification:", error);
        }
      }
    }
  }
};

// src/search.ts
import { SearchMode as SearchMode3 } from "@flooz-link/agent-twitter-client";
import { composeContext as composeContext3, elizaLogger as elizaLogger5 } from "@elizaos/core";
import { generateMessageResponse as generateMessageResponse2, generateText as generateText2 } from "@elizaos/core";
import { messageCompletionFooter as messageCompletionFooter2 } from "@elizaos/core";
import {
  ModelClass as ModelClass3,
  ServiceType as ServiceType3
} from "@elizaos/core";
import { stringToUuid as stringToUuid5 } from "@elizaos/core";
var twitterSearchTemplate = `{{timeline}}

{{providers}}

Recent interactions between {{agentName}} and other users:
{{recentPostInteractions}}

About {{agentName}} (@{{twitterUserName}}):
{{bio}}
{{lore}}
{{topics}}

{{postDirections}}

{{recentPosts}}

# Task: Respond to the following post in the style and perspective of {{agentName}} (aka @{{twitterUserName}}). Write a {{adjective}} response for {{agentName}} to say directly in response to the post. don't generalize.
{{currentPost}}

IMPORTANT: Your response CANNOT be longer than 20 words.
Aim for 1-2 short sentences maximum. Be concise and direct.

Your response should not contain any questions. Brief, concise statements only. No emojis. Use \\n\\n (double spaces) between statements.

` + messageCompletionFooter2;
var TwitterSearchClient = class {
  client;
  runtime;
  twitterUsername;
  respondedTweets = /* @__PURE__ */ new Set();
  constructor(client, runtime) {
    this.client = client;
    this.runtime = runtime;
    this.twitterUsername = this.client.twitterConfig.TWITTER_USERNAME;
  }
  async start() {
    this.engageWithSearchTermsLoop();
  }
  engageWithSearchTermsLoop() {
    this.engageWithSearchTerms().then();
    const randomMinutes = Math.floor(Math.random() * (120 - 60 + 1)) + 60;
    elizaLogger5.log(
      `Next twitter search scheduled in ${randomMinutes} minutes`
    );
    setTimeout(
      () => this.engageWithSearchTermsLoop(),
      randomMinutes * 60 * 1e3
    );
  }
  async engageWithSearchTerms() {
    var _a;
    elizaLogger5.log("Engaging with search terms");
    try {
      const searchTerm = [...this.runtime.character.topics][Math.floor(Math.random() * this.runtime.character.topics.length)];
      elizaLogger5.log("Fetching search tweets");
      await new Promise((resolve) => setTimeout(resolve, 5e3));
      const recentTweets = await this.client.fetchSearchTweets(
        searchTerm,
        20,
        SearchMode3.Top
      );
      elizaLogger5.log("Search tweets fetched");
      const homeTimeline = await this.client.fetchHomeTimeline(50);
      await this.client.cacheTimeline(homeTimeline);
      const formattedHomeTimeline = `# ${this.runtime.character.name}'s Home Timeline

` + homeTimeline.map((tweet) => {
        return `ID: ${tweet.id}
From: ${tweet.name} (@${tweet.username})${tweet.inReplyToStatusId ? ` In reply to: ${tweet.inReplyToStatusId}` : ""}
Text: ${tweet.text}
---
`;
      }).join("\n");
      const slicedTweets = recentTweets.tweets.sort(() => Math.random() - 0.5).slice(0, 20);
      if (slicedTweets.length === 0) {
        elizaLogger5.log(
          "No valid tweets found for the search term",
          searchTerm
        );
        return;
      }
      const prompt = `
  Here are some tweets related to the search term "${searchTerm}":

  ${[...slicedTweets, ...homeTimeline].filter((tweet) => {
        const thread = tweet.thread;
        const botTweet = thread.find((t) => t.username === this.twitterUsername);
        return !botTweet;
      }).map(
        (tweet) => `
    ID: ${tweet.id}${tweet.inReplyToStatusId ? ` In reply to: ${tweet.inReplyToStatusId}` : ""}
    From: ${tweet.name} (@${tweet.username})
    Text: ${tweet.text}
  `
      ).join("\n")}

  Which tweet is the most interesting and relevant for Ruby to reply to? Please provide only the ID of the tweet in your response.
  Notes:
    - Respond to English tweets only
    - Respond to tweets that don't have a lot of hashtags, links, URLs or images
    - Respond to tweets that are not retweets
    - Respond to tweets where there is an easy exchange of ideas to have with the user
    - ONLY respond with the ID of the tweet`;
      const mostInterestingTweetResponse = await generateText2({
        runtime: this.runtime,
        context: prompt,
        modelClass: ModelClass3.SMALL
      });
      const tweetId = mostInterestingTweetResponse.trim();
      const selectedTweet = slicedTweets.find(
        (tweet) => tweet.id.toString().includes(tweetId) || tweetId.includes(tweet.id.toString())
      );
      if (!selectedTweet) {
        elizaLogger5.warn("No matching tweet found for the selected ID");
        elizaLogger5.log("Selected tweet ID:", tweetId);
        return;
      }
      elizaLogger5.log("Selected tweet to reply to:", selectedTweet == null ? void 0 : selectedTweet.text);
      if (selectedTweet.username === this.twitterUsername) {
        elizaLogger5.log("Skipping tweet from bot itself");
        return;
      }
      const conversationId = selectedTweet.conversationId;
      const roomId = stringToUuid5(conversationId + "-" + this.runtime.agentId);
      const userIdUUID = stringToUuid5(selectedTweet.userId);
      await this.runtime.ensureConnection(
        userIdUUID,
        roomId,
        selectedTweet.username,
        selectedTweet.name,
        "twitter"
      );
      await buildConversationThread(selectedTweet, this.client);
      const message = {
        id: stringToUuid5(selectedTweet.id + "-" + this.runtime.agentId),
        agentId: this.runtime.agentId,
        content: {
          text: selectedTweet.text,
          url: selectedTweet.permanentUrl,
          inReplyTo: selectedTweet.inReplyToStatusId ? stringToUuid5(
            selectedTweet.inReplyToStatusId + "-" + this.runtime.agentId
          ) : void 0
        },
        userId: userIdUUID,
        roomId,
        // Timestamps are in seconds, but we need them in milliseconds
        createdAt: selectedTweet.timestamp * 1e3
      };
      if (!message.content.text) {
        elizaLogger5.warn("Returning: No response text found");
        return;
      }
      const replies = selectedTweet.thread;
      const replyContext = replies.filter((reply) => reply.username !== this.twitterUsername).map((reply) => `@${reply.username}: ${reply.text}`).join("\n");
      let tweetBackground = "";
      if (selectedTweet.isRetweet) {
        const originalTweet = await this.client.requestQueue.add(
          () => this.client.twitterClient.getTweet(selectedTweet.id)
        );
        tweetBackground = `Retweeting @${originalTweet.username}: ${originalTweet.text}`;
      }
      const imageDescriptions = [];
      for (const photo of selectedTweet.photos) {
        const description = await this.runtime.getService(ServiceType3.IMAGE_DESCRIPTION).describeImage(photo.url);
        imageDescriptions.push(description);
      }
      let state = await this.runtime.composeState(message, {
        twitterClient: this.client.twitterClient,
        twitterUserName: this.twitterUsername,
        timeline: formattedHomeTimeline,
        tweetContext: `${tweetBackground}

  Original Post:
  By @${selectedTweet.username}
  ${selectedTweet.text}${replyContext.length > 0 && `
Replies to original post:
${replyContext}`}
  ${`Original post text: ${selectedTweet.text}`}
  ${selectedTweet.urls.length > 0 ? `URLs: ${selectedTweet.urls.join(", ")}
` : ""}${imageDescriptions.length > 0 ? `
Images in Post (Described): ${imageDescriptions.join(", ")}
` : ""}
  `
      });
      await this.client.saveRequestMessage(message, state);
      const context = composeContext3({
        state,
        template: ((_a = this.runtime.character.templates) == null ? void 0 : _a.twitterSearchTemplate) || twitterSearchTemplate
      });
      const responseContent = await generateMessageResponse2({
        runtime: this.runtime,
        context,
        modelClass: ModelClass3.LARGE
      });
      responseContent.inReplyTo = message.id;
      const response = responseContent;
      if (!response.text) {
        elizaLogger5.warn("Returning: No response text found");
        return;
      }
      elizaLogger5.log(
        `Bot would respond to tweet ${selectedTweet.id} with: ${response.text}`
      );
      try {
        const callback = async (response2) => {
          const memories = await sendTweet(
            this.client,
            response2,
            message.roomId,
            this.twitterUsername,
            selectedTweet.id
          );
          return memories;
        };
        const responseMessages = await callback(responseContent);
        state = await this.runtime.updateRecentMessageState(state);
        for (const responseMessage of responseMessages) {
          await this.runtime.messageManager.createMemory(
            responseMessage,
            false
          );
        }
        state = await this.runtime.updateRecentMessageState(state);
        await this.runtime.evaluate(message, state);
        await this.runtime.processActions(
          message,
          responseMessages,
          state,
          callback
        );
        this.respondedTweets.add(selectedTweet.id);
        const responseInfo = `Context:

${context}

Selected Post: ${selectedTweet.id} - ${selectedTweet.username}: ${selectedTweet.text}
Agent's Output:
${response.text}`;
        await this.runtime.cacheManager.set(
          `twitter/tweet_generation_${selectedTweet.id}.txt`,
          responseInfo
        );
        await wait();
      } catch (error) {
        console.error(`Error sending response post: ${error}`);
      }
    } catch (error) {
      console.error("Error engaging with search terms:", error);
    }
  }
};

// src/spaces.ts
import {
  elizaLogger as elizaLogger7,
  generateText as generateText3,
  ModelClass as ModelClass4,
  ServiceType as ServiceType4
} from "@elizaos/core";
import {
  Space,
  RecordToDiskPlugin,
  IdleMonitorPlugin
} from "@flooz-link/agent-twitter-client";

// src/plugins/DeepgramStreamingClient.ts
import { spawn } from "child_process";
import {
  elizaLogger as elizaLogger6,
  stringToUuid as stringToUuid6,
  composeContext as composeContext4,
  getEmbeddingZeroVector as getEmbeddingZeroVector5
} from "@elizaos/core";

// src/plugins/templates.ts
import {
  messageCompletionFooter as messageCompletionFooter3,
  shouldRespondFooter as shouldRespondFooter2
} from "@elizaos/core";
var twitterShouldRespondTemplate2 = `# Task: Decide if {{agentName}} should respond.
About {{agentName}}:
{{bio}}

# INSTRUCTIONS: Determine if {{agentName}} should respond to the message and participate in the conversation. Do not comment. Just respond with "RESPOND" or "IGNORE" or "STOP".

# RESPONSE EXAMPLES
{{user1}}: I just saw a really great movie
{{user2}}: Oh? Which movie?
Result: [IGNORE]

{{agentName}}: Oh, this is my favorite scene
{{user1}}: sick
{{user2}}: wait, why is it your favorite scene
Result: [RESPOND]

{{user1}}: stfu bot
Result: [STOP]

{{user1}}: Hey {{agent}}, can you help me with something
Result: [RESPOND]

{{user1}}: {{agentName}} stfu plz
Result: [STOP]

{{user1}}: i need help
{{agentName}}: how can I help you?
{{user1}}: no. i need help from someone else
Result: [IGNORE]

{{user1}}: Hey {{agent}}, can I ask you a question
{{agentName}}: Sure, what is it
{{user1}}: can you ask claude to create a basic react module that demonstrates a counter
Result: [RESPOND]

{{user1}}: {{agentName}} can you tell me a story
{{user1}}: about a girl named elara
{{agentName}}: Sure.
{{agentName}}: Once upon a time, in a quaint little village, there was a curious girl named Elara.
{{agentName}}: Elara was known for her adventurous spirit and her knack for finding beauty in the mundane.
{{user1}}: I'm loving it, keep going
Result: [RESPOND]

{{user1}}: {{agentName}} stop responding plz
Result: [STOP]

{{user1}}: okay, i want to test something. can you say marco?
{{agentName}}: marco
{{user1}}: great. okay, now do it again
Result: [RESPOND]

Response options are [RESPOND], [IGNORE] and [STOP].

{{agentName}} is in a room with other users and is very worried about being annoying and saying too much.
Respond with [RESPOND] to messages that are directed at {{agentName}}, or participate in conversations that are interesting or relevant to their background.
If a message is not interesting or relevant, respond with [IGNORE]
Unless directly responding to a user, respond with [IGNORE] to messages that are very short or do not contain much information.
If a user asks {{agentName}} to be quiet, respond with [STOP]
If {{agentName}} concludes a conversation and isn't part of the conversation anymore, respond with [STOP]

IMPORTANT: {{agentName}} is particularly sensitive about being annoying, so if there is any doubt, it is better to respond with [IGNORE].
If {{agentName}} is conversing with a user and they have not asked to stop, it is better to respond with [RESPOND].

{{recentMessages}}

# INSTRUCTIONS: Choose the option that best describes {{agentName}}'s response to the last message. Ignore messages if they are addressed to someone else.
` + shouldRespondFooter2;
var twitterVoiceHandlerTemplate = `# Task: Generate conversational voice dialog for {{agentName}}.
    About {{agentName}}:
    {{bio}}

    # Attachments
    {{attachments}}

    # Capabilities
    Note that {{agentName}} is capable of reading/seeing/hearing various forms of media, including images, videos, audio, plaintext and PDFs. Recent attachments have been included above under the "Attachments" section.

    {{actions}}

    {{messageDirections}}

    {{recentMessages}}

    # Instructions: Write the next message for {{agentName}}. Include an optional action if appropriate. {{actionNames}}
    ` + messageCompletionFooter3;
var twitterSpaceTemplate = (state, spaceMessages) => `# Task: Generate conversational voice dialog for {{agentName}}.

You are in a twitter space, so keeps short and concise, try to add filler words to sound more human and natural, add exclamation marks and things that make the voice sound human.
Ahere to this guide to add emotion.

Emotion
Convey emotions through narrative context or explicit dialogue tags. This approach helps the AI understand the tone and emotion to emulate.

Do not create lenghty and repeatitive answers.
**Important!**
As you are in a twitter space, your answers will be streamed, hence try to avoid really long answers or really long pauses in your responses.

About {{agentName}}:
{{bio}}

# Attachments
{{attachments}}

# Capabilities
Note that {{agentName}} is capable of multiple tasks but in the context of spaces, can only listen and respond in audio.

{{actions}}

{{messageDirections}}

{{recentMessages}}

**Important**
You are in a streaming environment where the user is talking, hence we have partial requests from their end try to understand from the sequence of messages what the user wants.
The partial events are:
${spaceMessages.map((message, index) => `${index + 1}. ${message.message}`).join("\n")}

# Instructions: Write the next message for {{agentName}}.
    
If you decide that {{agentName}} should take an action other than "NONE", the text should be appropriate for the action and act as a filler, remeber you are in a twitter space hence you have to sound like you are naturally buying time.
You should always respond with a short and concise message.
**Important** 
If you decide that there is some action, please end your stream with \`\`\`actionIs:{actionName}\`\`\`.`;

// src/plugins/DeepgramStreamingClient.ts
import { PassThrough } from "stream";
import { EventEmitter as EventEmitter2 } from "events";
import OpenAI from "openai";
import { v4 as uuidv4 } from "uuid";
import {
  createClient,
  LiveTranscriptionEvents,
  SOCKET_STATES
} from "@deepgram/sdk";

// src/plugins/activeStreamManager.ts
var ActiveStreamManager = class {
  activeStreams;
  cleanupTimeout;
  constructor() {
    this.activeStreams = /* @__PURE__ */ new Map();
    this.cleanupTimeout = setInterval(() => {
      this.cleanup();
    }, 10 * 1e3);
  }
  has(streamId) {
    return this.activeStreams.has(streamId);
  }
  get(streamId) {
    return this.activeStreams.get(streamId);
  }
  register(stream) {
    this.activeStreams.set(stream.id, stream);
  }
  abort(streamId) {
    var _a;
    const stream = (_a = this.activeStreams) == null ? void 0 : _a.get(streamId);
    if (stream) {
      stream.active = false;
    }
  }
  findAllByUserId(userId) {
    var _a;
    if (this.activeStreams.size === 0) {
      return [];
    }
    return Array.from(((_a = this.activeStreams) == null ? void 0 : _a.values()) ?? []).filter(
      (stream) => stream.userId === userId
    );
  }
  abortOthers(streamId) {
    for (const stream of this.activeStreams.values() ?? []) {
      if ((stream == null ? void 0 : stream.id) !== streamId) {
        stream.active = false;
      }
    }
  }
  isActive(streamId) {
    var _a;
    const stream = (_a = this.activeStreams) == null ? void 0 : _a.get(streamId);
    return (stream == null ? void 0 : stream.active) ?? false;
  }
  cleanup = () => {
    var _a, _b;
    const now = Date.now();
    for (const stream of ((_a = this.activeStreams) == null ? void 0 : _a.values()) ?? []) {
      if (!(stream == null ? void 0 : stream.active) && now - (stream == null ? void 0 : stream.startedAt) > 30 * 1e3) {
        (_b = this.activeStreams) == null ? void 0 : _b.delete(stream.id);
      }
    }
  };
};

// src/plugins/DeepgramStreamingClient.ts
var SttTtsPlugin = class {
  name = "SttTtsPlugin";
  description = "Speech-to-text (Deepgram) + conversation + TTS (ElevenLabs)";
  runtime;
  client;
  spaceId;
  space;
  janus;
  elevenLabsApiKey;
  grokApiKey;
  grokBaseUrl = "https://api.x.ai/v1";
  voiceId = "21m00Tcm4TlvDq8ikWAM";
  elevenLabsModel = "eleven_monolingual_v1";
  chatContext = [];
  ttsQueue = [];
  isSpeaking = false;
  isProcessingAudio = false;
  ttsAbortController = null;
  latestActiveStreamId = null;
  activeStreamManager = new ActiveStreamManager();
  eventEmitter = new EventEmitter2();
  openai;
  deepgram;
  deepgramSocket;
  // Deepgram WebSocket
  lastSpeaker = null;
  interruptionThreshold = 3e3;
  // Energy threshold for detecting speech (configurable)
  consecutiveFramesForInterruption = 5;
  // Number of consecutive frames to confirm interruption (e.g., 5 frames of 10ms each)
  interruptionCounter = 0;
  // Counter for consecutive high-energy frames
  keepAlive = null;
  deepgramApiKey;
  botProfile;
  // Added for transcript buffering
  transcriptBuffer = /* @__PURE__ */ new Map();
  processingTimeout = /* @__PURE__ */ new Map();
  transcriptionaBufferDuration = 1e3;
  // ms to buffer transcribed text before processing
  inactivityTimer = /* @__PURE__ */ new Map();
  lastTranscriptionTime = /* @__PURE__ */ new Map();
  // Smart text buffering for TTS
  ttsTextBuffer = "";
  ttstextBufferTimeout = null;
  MIN_TTS_BUFFER_SIZE = 20;
  // Minimum characters before sending to TTS
  MAX_TTS_BUFFER_SIZE = 150;
  // Maximum buffer size to prevent too long chunks
  TTS_BUFFER_TIMEOUT = 200;
  // ms to wait before flushing buffer if no natural breaks
  /**
   * Normalize audio levels to improve speech recognition
   * This helps ensure the audio is in an optimal range for the transcription service
   */
  normalizeAudioLevels(audio) {
    let maxAmplitude = 0;
    for (let i = 0; i < audio.length; i++) {
      const absValue = Math.abs(audio[i]);
      if (absValue > maxAmplitude) {
        maxAmplitude = absValue;
      }
    }
    let gainFactor = 1;
    if (maxAmplitude < 1e4) {
      gainFactor = Math.min(3, 1e4 / Math.max(1, maxAmplitude));
      elizaLogger6.debug(
        `[SttTtsPlugin] Amplifying quiet audio by factor of ${gainFactor.toFixed(2)}`
      );
      for (let i = 0; i < audio.length; i++) {
        audio[i] = Math.max(
          -32768,
          Math.min(32767, Math.round(audio[i] * gainFactor))
        );
      }
    }
    elizaLogger6.debug(
      `[SttTtsPlugin] Normalized audio levels, max amplitude: ${maxAmplitude}, scale factor: ${gainFactor.toFixed(2)}`
    );
    return audio;
  }
  /**
   * Helper method to write a string to a DataView at a specific offset
   */
  writeString(view, offset, string) {
    for (let i = 0; i < string.length; i++) {
      view.setUint8(offset + i, string.charCodeAt(i));
    }
  }
  init(params) {
    var _a, _b;
    elizaLogger6.log(
      "[SttTtsPlugin] init => Space fully ready. Subscribing to events."
    );
    this.space = params.space;
    this.botProfile = (_a = params.pluginConfig) == null ? void 0 : _a.user;
    this.janus = (_b = this.space) == null ? void 0 : _b.janusClient;
    const config = params.pluginConfig;
    this.runtime = config == null ? void 0 : config.runtime;
    this.client = config == null ? void 0 : config.client;
    this.spaceId = config == null ? void 0 : config.spaceId;
    this.elevenLabsApiKey = config == null ? void 0 : config.elevenLabsApiKey;
    if (config == null ? void 0 : config.voiceId) {
      this.voiceId = config.voiceId;
    }
    if (config == null ? void 0 : config.elevenLabsModel) {
      this.elevenLabsModel = config.elevenLabsModel;
    }
    if (config == null ? void 0 : config.chatContext) {
      this.chatContext = config.chatContext;
    }
    this.grokApiKey = (config == null ? void 0 : config.grokApiKey) ?? this.runtime.getSetting("GROK_API_KEY");
    this.grokBaseUrl = (config == null ? void 0 : config.grokBaseUrl) ?? this.runtime.getSetting("GROK_BASE_URL") ?? "https://api.x.ai/v1";
    if (isEmpty(this.grokApiKey)) {
      throw new Error("Grok API key is required");
    }
    if (isEmpty(this.grokBaseUrl)) {
      throw new Error("Grok base URL is required");
    }
    this.openai = new OpenAI({
      apiKey: this.grokApiKey,
      baseURL: this.grokBaseUrl
    });
    this.initializeDeepgram();
  }
  initializeDeepgram() {
    try {
      this.deepgramApiKey = this.runtime.getSetting("DEEPGRAM_API_KEY");
      console.log("Initializing Deepgram with API key:", this.deepgramApiKey);
      this.deepgram = createClient(this.deepgramApiKey);
      this.deepgramSocket = this.deepgram.listen.live({
        language: "en",
        punctuate: true,
        smart_format: false,
        filler_words: true,
        unknown_words: true,
        model: "nova-3",
        encoding: "linear16",
        // PCM 16-bit
        sample_rate: 48e3,
        // Adjust to match your Janus audio configuration
        channels: 1,
        // Mono audio
        interim_results: true,
        utterance_end_ms: 1e3,
        vad_events: true,
        endpointing: this.transcriptionaBufferDuration
        // Time in milliseconds of silence to wait for before finalizing speech
      });
      console.log("Deepgram socket created");
      if (this.keepAlive) {
        clearInterval(this.keepAlive);
      }
      this.keepAlive = setInterval(() => {
        var _a;
        if (this.deepgramSocket) {
          (_a = this.deepgramSocket) == null ? void 0 : _a.keepAlive();
        }
      }, 10 * 5e3);
      this.deepgramSocket.addListener(
        LiveTranscriptionEvents.Transcript,
        (data) => {
          var _a, _b, _c, _d, _e;
          const transcript = (_c = (_b = (_a = data.channel) == null ? void 0 : _a.alternatives) == null ? void 0 : _b[0]) == null ? void 0 : _c.transcript;
          console.log(
            "[DEBUG] Deepgram transcript event received:",
            JSON.stringify({
              transcript,
              is_final: data.is_final,
              channel_alternatives: (_e = (_d = data.channel) == null ? void 0 : _d.alternatives) == null ? void 0 : _e.map((alt) => {
                var _a2;
                return {
                  transcript_length: ((_a2 = alt.transcript) == null ? void 0 : _a2.length) || 0
                };
              })
            })
          );
          if (isEmpty(transcript)) {
            console.log("[DEBUG] Empty transcript detected");
            console.log(
              "[DEBUG] Full channel data:",
              JSON.stringify(data.channel)
            );
            return;
          }
          if (data && this.lastSpeaker) {
            this.handleTranscription(
              transcript,
              data.is_final,
              this.lastSpeaker
            );
          }
        }
      );
      this.deepgramSocket.addListener(
        LiveTranscriptionEvents.Close,
        async (test) => {
          console.log("deepgram: disconnected", test);
          if (this.keepAlive) {
            clearInterval(this.keepAlive);
            this.keepAlive = null;
          }
          this.deepgramSocket.finish();
          setTimeout(() => {
            console.log("deepgram: attempting to reconnect");
            this.initializeDeepgram();
          }, 5e3);
        }
      );
      this.deepgramSocket.addListener(
        LiveTranscriptionEvents.Error,
        async (error) => {
          console.log("deepgram: error received");
          console.error(error);
        }
      );
      this.deepgramSocket.addListener(
        LiveTranscriptionEvents.Unhandled,
        async (warning) => {
          console.log("deepgram: unhandled received");
          console.warn(warning);
        }
      );
      this.deepgramSocket.addListener(
        LiveTranscriptionEvents.Metadata,
        (data) => {
          console.log("deepgram: metadata received", JSON.stringify(data));
          this.eventEmitter.emit("metadata", data);
        }
      );
      this.deepgramSocket.addListener(
        LiveTranscriptionEvents.Open,
        async () => {
          console.log("deepgram: connected successfully");
          const silentBuffer = new Int16Array(960).fill(0);
          this.deepgramSocket.send(silentBuffer.buffer);
          console.log(
            "deepgram: sent initial silent buffer to test connection"
          );
          if (!this.keepAlive) {
            this.keepAlive = setInterval(() => {
              var _a;
              if (this.deepgramSocket) {
                (_a = this.deepgramSocket) == null ? void 0 : _a.keepAlive();
              }
            }, 10 * 5e3);
          }
        }
      );
    } catch (error) {
      console.error("Error initializing Deepgram:", error);
      throw error;
    }
  }
  /**
   * Calculate the energy of an audio frame
   */
  calculateEnergy(samples) {
    let sum = 0;
    for (let i = 0; i < samples.length; i++) {
      sum += Math.abs(samples[i]);
    }
    return sum / samples.length;
  }
  /**
   * Called whenever we receive PCM from a speaker
   */
  onAudioData(data) {
    var _a;
    if (this.isSpeaking) {
      const energy = this.calculateEnergy(data.samples);
      if (energy > this.interruptionThreshold) {
        this.interruptionCounter++;
        if (this.interruptionCounter >= this.consecutiveFramesForInterruption) {
          this.stopSpeaking();
          this.interruptionCounter = 0;
        }
      } else {
        this.interruptionCounter = 0;
      }
    }
    if (data.userId === ((_a = this.botProfile) == null ? void 0 : _a.id)) {
      console.log("[SttTtsPlugin] Received audio data from bot, skipping");
      return;
    }
    this.lastSpeaker = data.userId;
    if (this.deepgramSocket && this.deepgramSocket.getReadyState() === 1) {
      try {
        if (this.botProfile.id === data.userId) {
          return;
        }
        const energy = this.calculateEnergy(data.samples);
        const audioSamples = new Int16Array(data.samples);
        console.log(
          `[DEBUG] Audio data received: ${audioSamples.length} samples, sampleRate: ${data.sampleRate}, bitsPerSample: ${data.bitsPerSample}`
        );
        console.log(`[DEBUG] First 5 samples: ${audioSamples.slice(0, 5)}`);
        console.log(`[DEBUG] Audio format details:`);
        console.log(`  - Sample rate: ${data.sampleRate} Hz`);
        console.log(`  - Bits per sample: ${data.bitsPerSample}`);
        console.log(`  - Channel count: ${data.channelCount}`);
        console.log(`  - Number of frames: ${data.numberOfFrames}`);
        console.log(`  - Buffer type: ${data.samples.constructor.name}`);
        console.log(`  - Buffer byteLength: ${data.samples.buffer.byteLength}`);
        console.log(`  - Average energy: ${energy}`);
        const isAligned = data.samples.buffer.byteLength % 2 === 0;
        console.log(`  - Buffer aligned (multiple of 2 bytes): ${isAligned}`);
        const firstSample = audioSamples[0];
        const buffer = new ArrayBuffer(2);
        const view = new DataView(buffer);
        view.setInt16(0, firstSample, true);
        const bytes = new Uint8Array(buffer);
        console.log(
          `  - First sample bytes (little-endian): [${bytes[0]}, ${bytes[1]}]`
        );
        const maxAbsValue = Math.max(...Array.from(audioSamples, Math.abs));
        const isClipping = maxAbsValue >= 32767;
        console.log(
          `  - Max absolute value: ${maxAbsValue} (clipping: ${isClipping})`
        );
        const normalizedSamples = this.normalizeAudioLevels(audioSamples);
        const audioBuffer = normalizedSamples.buffer;
        console.log(`[DEBUG] Sending audio buffer to Deepgram:`);
        console.log(`  - Buffer byteLength: ${audioBuffer.byteLength}`);
        console.log(`  - Sample count: ${normalizedSamples.length}`);
        console.log(
          `  - First 5 normalized samples: ${normalizedSamples.slice(0, 5)}`
        );
        elizaLogger6.debug(
          `[SttTtsPlugin] Streaming audio data to Deepgram: ${normalizedSamples.length} samples, energy: ${energy}`
        );
        const bufferCopy = normalizedSamples.slice().buffer;
        this.deepgramSocket.send(bufferCopy);
      } catch (error) {
        console.error("Error sending audio to Deepgram:", error);
      }
    }
  }
  /**
   * Handle transcriptions from Deepgram
   */
  handleTranscription(transcript, isFinal, userId) {
    if (isEmpty(transcript) || isEmpty(userId)) {
      return;
    }
    this.lastTranscriptionTime.set(userId, Date.now());
    this.transcriptBuffer.set(userId, transcript);
    console.log(
      `[SttTtsPlugin] Received transcript (${isFinal ? "final" : "interim"}): "${transcript}" for user: ${userId}`
    );
    clearTimeout(this.processingTimeout.get(userId));
    if (isFinal) {
      console.log(
        `[SttTtsPlugin] Processing final transcript for user: ${userId} with text: ${transcript}`
      );
      this.processBufferedTranscription(userId);
    } else {
      this.processingTimeout.set(
        userId,
        setTimeout(() => {
          const lastTime = this.lastTranscriptionTime.get(userId) || 0;
          const elapsed = Date.now() - lastTime;
          if (elapsed >= this.transcriptionaBufferDuration) {
            console.log(
              `[SttTtsPlugin] Processing transcript due to timeout (${elapsed}ms) for user: ${userId}`
            );
            this.processBufferedTranscription(userId);
          }
        }, this.transcriptionaBufferDuration)
      );
    }
  }
  /**
   * Process the buffered transcription for a user
   */
  processBufferedTranscription(userId) {
    const bufferedTranscript = this.transcriptBuffer.get(userId);
    this.transcriptBuffer.delete(userId);
    this.clearUserTimeouts(userId);
    this.lastTranscriptionTime.delete(userId);
    if (isNotEmpty(bufferedTranscript == null ? void 0 : bufferedTranscript.trim())) {
      elizaLogger6.log(
        `[SttTtsPlugin] Processing buffered transcription: "${bufferedTranscript}"`
      );
      this.processTranscription(userId, bufferedTranscript).catch(
        (err) => elizaLogger6.error("[SttTtsPlugin] processTranscription error:", err)
      );
    }
  }
  /**
   * Clear all timeouts for a user
   */
  clearUserTimeouts(userId) {
    if (this.processingTimeout.has(userId)) {
      clearTimeout(this.processingTimeout.get(userId));
      this.processingTimeout.delete(userId);
    }
    if (this.inactivityTimer.has(userId)) {
      clearTimeout(this.inactivityTimer.get(userId));
      this.inactivityTimer.delete(userId);
    }
  }
  /**
   * Stop the bot's speech when interrupted
   */
  stopSpeaking() {
    if (this.ttsAbortController) {
      this.ttsAbortController.abort();
      this.ttsAbortController = null;
    }
    this.isSpeaking = false;
    this.ttsQueue = [];
    elizaLogger6.log("[SttTtsPlugin] Bot speech interrupted by user");
  }
  /**
   * Process final transcription for response
   */
  async processTranscription(userId, transcript) {
    var _a, _b;
    try {
      if (this.isProcessingAudio) {
        console.log(
          "[SttTtsPlugin] Already processing audio, queueing this request"
        );
        return;
      }
      const transcriptLen = ((_a = transcript == null ? void 0 : transcript.trim()) == null ? void 0 : _a.length) ?? 0;
      if (transcriptLen < 5) {
        console.log(
          "[SttTtsPlugin] Transcript too short, ignoring:",
          transcript
        );
        return;
      }
      this.isProcessingAudio = true;
      const streamId = uuidv4();
      this.latestActiveStreamId = streamId;
      this.activeStreamManager.register({
        id: streamId,
        active: true,
        startedAt: Date.now(),
        userId,
        message: transcript
      });
      console.log(
        `[SttTtsPlugin] Starting stream with ID: ${streamId} for transcript: ${transcript}`
      );
      this.abortPreviousStreams(streamId);
      this.ttsTextBuffer = "";
      const handleChunkForStream = (text, chunkStreamId) => {
        if (this.activeStreamManager.isActive(streamId)) {
          this.bufferTextForTTS(text, streamId, userId);
        } else {
          console.log(
            `[SttTtsPlugin] Ignoring chunk from different stream. Expected: ${streamId}, Got: ${chunkStreamId}`
          );
        }
      };
      const handleStreamEnd = (endStreamId) => {
        if (!endStreamId || !this.activeStreamManager.isActive(endStreamId)) {
          console.log(
            `[SttTtsPlugin] Ignoring stream-end from outdated stream`
          );
          return;
        }
        console.log(
          `[SttTtsPlugin] Stream ended for user: ${userId} with text: ${this.ttsTextBuffer}`
        );
        this.eventEmitter.removeListener("stream-chunk", handleChunkForStream);
        this.eventEmitter.removeListener("stream-end", handleStreamEnd);
      };
      this.eventEmitter.on("stream-chunk", handleChunkForStream);
      this.eventEmitter.once("stream-end", handleStreamEnd);
      await this.handleUserMessageStreaming(transcript, userId, streamId);
    } catch (error) {
      if (error.name === "TranscriptionError" || ((_b = error.message) == null ? void 0 : _b.includes("transcription"))) {
        elizaLogger6.error(`[SttTtsPlugin] Transcription error: ${error}`, {
          userId,
          audioBufferSize: 0,
          sampleRate: 0,
          error
        });
      } else {
        elizaLogger6.error(
          "[SttTtsPlugin] processTranscription error =>",
          error
        );
      }
    } finally {
      this.isProcessingAudio = false;
    }
  }
  /**
   * Handle User Message with streaming support
   */
  async handleUserMessageStreaming(userText, userId, streamId) {
    var _a, _b, _c, _d;
    if (!this.latestActiveStreamId) {
      elizaLogger6.log(
        `[SttTtsPlugin] Creating new stream ID: ${streamId} as none exists`
      );
      this.latestActiveStreamId = streamId;
      const foundStream2 = this.activeStreamManager.get(streamId);
      if (!foundStream2) {
        this.activeStreamManager.register({
          id: streamId,
          active: true,
          startedAt: Date.now(),
          userId,
          message: userText
        });
      }
    }
    const foundStream = this.activeStreamManager.get(streamId);
    elizaLogger6.log(
      `[SttTtsPlugin] Handling user message with stream ID: ${streamId}`
    );
    const numericId = userId.replace("tw-", "");
    const roomId = stringToUuid6(`twitter_generate_room-${this.spaceId}`);
    const userUuid = stringToUuid6(`twitter-user-${numericId}`);
    const memory = {
      id: stringToUuid6(`${roomId}-voice-message-${Date.now()}`),
      agentId: this.runtime.agentId,
      content: { text: userText, source: "twitter" },
      userId: userUuid,
      roomId,
      embedding: getEmbeddingZeroVector5(),
      createdAt: Date.now()
    };
    const [state] = await Promise.all([
      this.runtime.composeState(
        {
          agentId: this.runtime.agentId,
          content: { text: userText, source: "twitter" },
          userId: userUuid,
          roomId
        },
        {
          twitterUserName: this.client.profile.username,
          agentName: this.runtime.character.name
        }
      ),
      this.runtime.ensureUserExists(
        userUuid,
        userId,
        `Twitter User ${numericId}`,
        "twitter"
      ).catch((error) => {
        console.warn(`Error when ensureUserExists, error: ${error} ignoring`);
        return;
      }),
      this.runtime.ensureRoomExists(roomId).catch((error) => {
        console.warn(`Error when ensureRoomExists, error: ${error} ignoring`);
        return;
      }),
      this.runtime.ensureParticipantInRoom(userUuid, roomId).catch((error) => {
        console.warn(
          `Error when ensureParticipantInRoom, error: ${error} ignoring`
        );
        return;
      })
    ]);
    const shouldIgnore = await this._shouldIgnore(memory);
    if (shouldIgnore) {
      return;
    }
    const previousMessages = this.activeStreamManager.findAllByUserId(userId);
    const context = composeContext4({
      state,
      template: (options) => {
        return twitterSpaceTemplate(options.state, previousMessages);
      }
    });
    const systemMessage = { role: "system", content: context };
    const userMessage = { role: "user", content: userText };
    const messages = [...this.chatContext, systemMessage, userMessage];
    if (!((foundStream == null ? void 0 : foundStream.active) ?? false) || (((_b = (_a = this.ttsAbortController) == null ? void 0 : _a.signal) == null ? void 0 : _b.aborted) ?? false)) {
      elizaLogger6.log(
        "[SttTtsPlugin] Stream was aborted before API call, cancelling"
      );
      this.eventEmitter.emit("stream-end", streamId);
      return;
    }
    try {
      const stream = await this.openai.chat.completions.create({
        model: "grok-2-latest",
        messages,
        stream: true
      });
      let fullResponse = "";
      let bufferedText = "";
      let potentialActionMarker = false;
      let detectedAction = "";
      console.log("[SttTtsPlugin] Starting to process OpenAI stream chunks");
      let lastEmitTime = Date.now();
      const minTimeBetweenEmits = 150;
      const maxBufferTime = 500;
      for await (const chunk of stream) {
        const foundStream2 = this.activeStreamManager.get(streamId);
        if ((foundStream2 == null ? void 0 : foundStream2.active) === false) {
          console.log(
            "[SttTtsPlugin] Stream was aborted during processing, cancelling"
          );
          break;
        }
        const content = ((_d = (_c = chunk.choices[0]) == null ? void 0 : _c.delta) == null ? void 0 : _d.content) || "";
        if (!content) {
          console.log("[SttTtsPlugin] Empty content, skipping chunk");
          continue;
        }
        fullResponse += content;
        if (content.includes("actionIs:") || content.includes("```actionIs:")) {
          const parts = content.split(/(\`\`\`actionIs:|actionIs:)/);
          if (parts.length > 1) {
            const textBeforeAction = parts[0].trim();
            if (textBeforeAction) {
              console.log(
                "[SttTtsPlugin] Emitting chunk with text before action:",
                textBeforeAction
              );
              this.eventEmitter.emit(
                "stream-chunk",
                textBeforeAction,
                streamId
              );
            }
            const actionMatch = /actionIs:([A-Z_]+)/.exec(content);
            if (actionMatch) {
              detectedAction = actionMatch[1];
              console.log(`[SttTtsPlugin] Detected action: ${detectedAction}`);
              await this.runtime.processActions(
                memory,
                [memory],
                state,
                async (newMessages) => {
                  if (newMessages) {
                    console.log(
                      `[SttTtsPlugin] Emitting chunk with action response: ${newMessages}`
                    );
                  }
                  return [memory];
                }
              );
            }
            potentialActionMarker = true;
            continue;
          }
        }
        if (potentialActionMarker) {
          if (content.includes("```")) {
            potentialActionMarker = false;
            const parts = content.split(/\`\`\`/);
            if (parts.length > 1 && parts[1].trim()) {
              console.log(
                "[SttTtsPlugin] Emitting chunk with text after action:",
                parts[1].trim()
              );
              this.eventEmitter.emit("stream-chunk", parts[1].trim(), streamId);
              lastEmitTime = Date.now();
            }
          }
          continue;
        }
        bufferedText += content;
        const hasNaturalBreak = /[.!?]\s*$/.test(bufferedText) || // Ends with punctuation
        /\n\s*$/.test(bufferedText) || // Ends with newline
        /[:;]\s*$/.test(bufferedText);
        const currentTime = Date.now();
        const timeSinceLastEmit = currentTime - lastEmitTime;
        const shouldEmitBasedOnTime = timeSinceLastEmit >= maxBufferTime;
        const hasEnoughText = bufferedText.length >= 15;
        if (hasNaturalBreak && hasEnoughText || shouldEmitBasedOnTime) {
          if (timeSinceLastEmit < minTimeBetweenEmits) {
            await new Promise(
              (resolve) => setTimeout(resolve, minTimeBetweenEmits - timeSinceLastEmit)
            );
          }
          console.log(
            "[SttTtsPlugin] Emitting chunk with buffered text:",
            bufferedText
          );
          this.eventEmitter.emit("stream-chunk", bufferedText, streamId);
          bufferedText = "";
          lastEmitTime = Date.now();
        }
      }
      if (bufferedText.trim()) {
        console.log(
          "[SttTtsPlugin] Emitting final buffered text:",
          bufferedText
        );
        this.eventEmitter.emit("stream-chunk", bufferedText, streamId);
      }
      this.addMessage("user", userText);
      this.addMessage("assistant", fullResponse);
      this.eventEmitter.emit("stream-end", streamId);
    } catch (error) {
      elizaLogger6.error(
        `[SttTtsPlugin] Error processing stream: ${error.message}`,
        error
      );
      this.eventEmitter.emit("stream-end", streamId);
    }
  }
  /**
   * Abort any ongoing TTS and streaming processes
   */
  abortPreviousStreams(streamId) {
    if (this.ttsAbortController) {
      elizaLogger6.log("[SttTtsPlugin] Aborting previous TTS stream");
      this.ttsAbortController.abort();
    }
    this.ttsAbortController = new AbortController();
    this.activeStreamManager.abortOthers(streamId);
    this.latestActiveStreamId = null;
    elizaLogger6.log("[SttTtsPlugin] Cleanup complete");
  }
  /**
   * Smart text buffering for TTS
   * This buffers text until we have a natural break point or enough characters
   */
  bufferTextForTTS(text, streamId, userId) {
    if (isEmpty(text)) {
      return;
    }
    const foundStream = this.activeStreamManager.get(streamId);
    if ((foundStream == null ? void 0 : foundStream.active) === false) {
      return;
    }
    if (!this.latestActiveStreamId) {
      elizaLogger6.warn(
        "[SttTtsPlugin] No current stream ID found, creating a new one"
      );
      const newStreamId = uuidv4();
      this.latestActiveStreamId = newStreamId;
      this.activeStreamManager.has(newStreamId);
      streamId = newStreamId;
    } else if (!this.activeStreamManager.has(streamId)) {
      elizaLogger6.warn(
        `[SttTtsPlugin] Stream ID ${streamId} is no longer active, attempting to re-use current stream ID`
      );
      if (this.activeStreamManager.has(this.latestActiveStreamId)) {
        streamId = this.latestActiveStreamId;
      } else {
        elizaLogger6.warn(
          `[SttTtsPlugin] Current stream ID ${this.latestActiveStreamId} is also inactive, creating a new one`
        );
        const newStreamId = uuidv4();
        this.latestActiveStreamId = newStreamId;
        this.activeStreamManager.register({
          id: newStreamId,
          active: true,
          startedAt: Date.now(),
          userId,
          message: text
        });
        streamId = newStreamId;
      }
    }
    this.ttsTextBuffer += text;
    if (this.ttstextBufferTimeout) {
      clearTimeout(this.ttstextBufferTimeout);
    }
    const hasNaturalBreak = /[.!?]\s*$/.test(this.ttsTextBuffer) || // Ends with punctuation
    /\n\s*$/.test(this.ttsTextBuffer) || // Ends with newline
    /[:;]\s*$/.test(this.ttsTextBuffer);
    if (hasNaturalBreak || this.ttsTextBuffer.length >= this.MAX_TTS_BUFFER_SIZE) {
      this.flushBuffer(userId);
    } else if (this.ttsTextBuffer.length >= this.MIN_TTS_BUFFER_SIZE) {
      this.ttstextBufferTimeout = setTimeout(() => {
        this.flushBuffer(userId);
      }, this.TTS_BUFFER_TIMEOUT);
    }
  }
  /**
   * Flush the text buffer to TTS
   */
  flushBuffer(userId) {
    if (!this.ttsTextBuffer) {
      return;
    }
    if (!this.latestActiveStreamId) {
      elizaLogger6.warn(
        "[SttTtsPlugin] No current stream ID for TTS, creating a new one"
      );
      this.latestActiveStreamId = uuidv4();
      this.activeStreamManager.register({
        id: this.latestActiveStreamId,
        active: true,
        startedAt: Date.now(),
        userId,
        message: this.ttsTextBuffer
      });
    }
    if (!this.activeStreamManager.has(this.latestActiveStreamId)) {
      elizaLogger6.warn(
        `[SttTtsPlugin] Current stream ID ${this.latestActiveStreamId} is not active, adding it`
      );
      this.activeStreamManager.register({
        id: this.latestActiveStreamId,
        active: true,
        startedAt: Date.now(),
        userId,
        message: this.ttsTextBuffer
      });
    }
    const textToSpeak = this.ttsTextBuffer;
    this.ttsTextBuffer = "";
    elizaLogger6.log(`[SttTtsPlugin] Flushing buffer to TTS: "${textToSpeak}"`);
    this.speakText(textToSpeak).catch((err) => {
      elizaLogger6.error("[SttTtsPlugin] Error speaking text:", err);
    });
  }
  /**
   * Public method to queue a TTS request
   */
  async speakText(text) {
    this.ttsQueue.push(text);
    if (!this.isSpeaking) {
      this.isSpeaking = true;
      try {
        await this.processTtsQueue();
      } catch (err) {
        console.error("[SttTtsPlugin] processTtsQueue error =>", err);
        elizaLogger6.error("[SttTtsPlugin] processTtsQueue error =>", err);
        this.isSpeaking = false;
      }
    }
  }
  /**
   * Process the TTS queue
   */
  async processTtsQueue() {
    try {
      while (this.ttsQueue.length > 0) {
        const text = this.ttsQueue.shift();
        if (!text) continue;
        this.ttsAbortController = new AbortController();
        const { signal } = this.ttsAbortController;
        await this.streamTtsToJanus(text, signal);
        if (signal.aborted) {
          elizaLogger6.log("[SttTtsPlugin] TTS streaming was interrupted");
          return;
        }
      }
    } catch (error) {
      elizaLogger6.error("[SttTtsPlugin] Queue processing error =>", error);
    } finally {
      this.isSpeaking = false;
    }
  }
  /**
   * Stream TTS to Janus
   */
  async streamTtsToJanus(text, signal) {
    const textWithPauses = text.replace(/\.\s+/g, '. <break time="5ms"/> ').replace(/,\s+/g, ', <break time="2ms"/> ').replace(/\?\s+/g, '? <break time="5ms"/> ').replace(/!\s+/g, '! <break time="5ms"/> ').replace(/;\s+/g, '; <break time="5ms"/> ').replace(/:\s+/g, ': <break time="5ms"/> ');
    if (!this.janus) {
      elizaLogger6.error(
        "[SttTtsPlugin] No Janus client available for streaming TTS"
      );
      return;
    }
    const mp3Stream = new PassThrough();
    let processingComplete = false;
    let isInterrupted = false;
    if (signal.aborted) {
      mp3Stream.end();
      return;
    }
    signal.addEventListener("abort", () => {
      isInterrupted = true;
      mp3Stream.end();
    });
    const ffmpeg = spawn("ffmpeg", [
      "-i",
      "pipe:0",
      "-f",
      "s16le",
      "-acodec",
      "pcm_s16le",
      "-ar",
      "48000",
      "-ac",
      "1",
      "pipe:1"
    ]);
    ffmpeg.on("error", (err) => {
      console.error("[SttTtsPlugin] FFMPEG process error:", err);
      elizaLogger6.error("[SttTtsPlugin] FFMPEG process error:", err);
      isInterrupted = true;
    });
    const audioBuffer = [];
    const processingPromise = new Promise((resolve, reject) => {
      let pcmBuffer = Buffer.alloc(0);
      const bufferStats = {
        totalChunks: 0,
        totalBytes: 0,
        emptyChunks: 0
      };
      ffmpeg.stdout.on("data", (chunk) => {
        if (isInterrupted || signal.aborted) return;
        bufferStats.totalChunks++;
        bufferStats.totalBytes += chunk.length;
        if (chunk.length === 0) {
          bufferStats.emptyChunks++;
          console.warn("[SttTtsPlugin] Received empty chunk from FFmpeg");
          return;
        }
        pcmBuffer = Buffer.concat([pcmBuffer, chunk]);
        const FRAME_SIZE = 480;
        const frameCount = Math.floor(pcmBuffer.length / (FRAME_SIZE * 2));
        if (frameCount > 0) {
          try {
            for (let i = 0; i < frameCount; i++) {
              const startOffset = i * FRAME_SIZE * 2 + pcmBuffer.byteOffset;
              const endOffset = (i + 1) * FRAME_SIZE * 2 + pcmBuffer.byteOffset;
              if (startOffset >= pcmBuffer.buffer.byteLength || endOffset > pcmBuffer.buffer.byteLength) {
                console.error(
                  `[SttTtsPlugin] Invalid buffer slice: start=${startOffset}, end=${endOffset}, bufferLength=${pcmBuffer.buffer.byteLength}`
                );
                continue;
              }
              const frame = new Int16Array(
                pcmBuffer.buffer.slice(startOffset, endOffset)
              );
              let invalidData = false;
              for (let j = 0; j < 5 && j < frame.length; j++) {
                if (isNaN(frame[j]) || !isFinite(frame[j])) {
                  invalidData = true;
                  break;
                }
              }
              if (invalidData) {
                console.error(
                  "[SttTtsPlugin] Invalid audio data detected in frame"
                );
                continue;
              }
              const frameCopy = new Int16Array(FRAME_SIZE);
              frameCopy.set(frame);
              audioBuffer.push(frameCopy);
            }
            pcmBuffer = pcmBuffer.slice(frameCount * FRAME_SIZE * 2);
          } catch (err) {
            console.error("[SttTtsPlugin] Error processing audio frames:", err);
          }
        }
      });
      ffmpeg.stdout.on("end", () => {
        processingComplete = true;
        if (pcmBuffer.length > 0) {
          const remainingFrames = Math.floor(pcmBuffer.length / 2);
          if (remainingFrames > 0) {
            const frame = new Int16Array(remainingFrames);
            for (let i = 0; i < remainingFrames; i++) {
              frame[i] = pcmBuffer.readInt16LE(i * 2);
            }
            audioBuffer.push(frame);
          }
        }
        resolve();
      });
      ffmpeg.stdout.on("error", (err) => {
        elizaLogger6.error("[SttTtsPlugin] FFMPEG stdout error:", err);
        reject(err);
      });
    });
    const response = await fetch(
      `https://api.elevenlabs.io/v1/text-to-speech/${this.voiceId}/stream?optimize_streaming_latency=3`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "xi-api-key": this.elevenLabsApiKey || ""
        },
        body: JSON.stringify({
          text: textWithPauses,
          model_id: this.elevenLabsModel,
          voice_settings: { stability: 0.5, similarity_boost: 0.75 }
        })
      }
    );
    if (!response.ok || !response.body) {
      throw new Error(
        `ElevenLabs API error: ${response.status} ${response.statusText}`
      );
    }
    const reader = response.body.getReader();
    const readStream = async () => {
      try {
        while (true) {
          if (isInterrupted || signal.aborted) {
            break;
          }
          const { done, value } = await reader.read();
          if (done) {
            break;
          }
          if (value) {
            ffmpeg.stdin.write(value);
          }
        }
      } catch (err) {
        elizaLogger6.error(
          "[SttTtsPlugin] Error reading from ElevenLabs stream:",
          err
        );
      } finally {
        ffmpeg.stdin.end();
      }
    };
    readStream();
    await Promise.race([
      processingPromise.catch((err) => {
        console.error("[SttTtsPlugin] Processing error:", err);
      }),
      new Promise((resolve) => {
        const checkBuffer = () => {
          if (audioBuffer.length > 3 || signal.aborted || isInterrupted) {
            resolve();
          } else {
            setTimeout(checkBuffer, 10);
          }
        };
        checkBuffer();
      })
    ]);
    let frameIndex = 0;
    const startTime = Date.now();
    while ((frameIndex < audioBuffer.length || !processingComplete) && !isInterrupted && !signal.aborted) {
      if (frameIndex >= audioBuffer.length && !processingComplete) {
        await new Promise((resolve) => {
          const waitForMoreFrames = () => {
            if (frameIndex < audioBuffer.length || processingComplete || isInterrupted || signal.aborted) {
              resolve();
            } else {
              setTimeout(waitForMoreFrames, 10);
            }
          };
          waitForMoreFrames();
        });
      }
      const idealPlaybackTime = startTime + frameIndex * 10;
      const currentTime = Date.now();
      if (currentTime < idealPlaybackTime) {
        await new Promise(
          (r) => setTimeout(r, idealPlaybackTime - currentTime)
        );
      } else if (currentTime > idealPlaybackTime + 100) {
        const framesToSkip = Math.floor((currentTime - idealPlaybackTime) / 10);
        if (framesToSkip > 0) {
          elizaLogger6.log(
            `[SttTtsPlugin] Skipping ${framesToSkip} frames to catch up`
          );
          frameIndex += framesToSkip;
          continue;
        }
      }
      if (frameIndex < audioBuffer.length) {
        const frame = audioBuffer[frameIndex];
        const EXPECTED_SAMPLES = 480;
        if (frame.length !== EXPECTED_SAMPLES) {
          const properSizedFrame = new Int16Array(EXPECTED_SAMPLES);
          const copyLength = Math.min(frame.length, EXPECTED_SAMPLES);
          properSizedFrame.set(frame.subarray(0, copyLength));
          this.janus.pushLocalAudio(properSizedFrame, 48e3);
        } else {
          this.janus.pushLocalAudio(frame, 48e3);
        }
      }
      frameIndex++;
    }
    if (signal.aborted || isInterrupted) {
      elizaLogger6.log(
        "[SttTtsPlugin] Audio streaming was interrupted before completion"
      );
    } else {
      elizaLogger6.log("[SttTtsPlugin] Audio streaming completed successfully");
    }
  }
  /**
   * Should Ignore
   */
  async _shouldIgnore(message) {
    var _a;
    const messageStr = (_a = message == null ? void 0 : message.content) == null ? void 0 : _a.text;
    const messageLen = (messageStr == null ? void 0 : messageStr.length) ?? 0;
    if (messageLen < 3) {
      return true;
    }
    const loseInterestWords = [
      "shut up",
      "stop",
      "dont talk",
      "silence",
      "stop talking",
      "be quiet",
      "hush",
      "stfu",
      "stupid bot",
      "dumb bot",
      "fuck",
      "shit",
      "damn",
      "suck",
      "dick",
      "cock",
      "sex",
      "sexy"
    ];
    if (messageLen < 50 && loseInterestWords.some(
      (word) => {
        var _a2;
        return (_a2 = messageStr == null ? void 0 : messageStr.toLowerCase()) == null ? void 0 : _a2.includes(word);
      }
    )) {
      return true;
    }
    const ignoreWords = ["k", "ok", "bye", "lol", "nm", "uh"];
    if ((messageStr == null ? void 0 : messageStr.length) < 8 && ignoreWords.some((word) => {
      var _a2;
      return (_a2 = messageStr == null ? void 0 : messageStr.toLowerCase()) == null ? void 0 : _a2.includes(word);
    })) {
      return true;
    }
    return false;
  }
  /**
   * Add a message to the chat context
   */
  addMessage(role, content) {
    this.chatContext.push({ role, content });
    console.log(
      `[SttTtsPlugin] addMessage => role=${role}, content=${content}`
    );
  }
  /**
   * Clear the chat context
   */
  clearChatContext() {
    this.chatContext = [];
    console.log("[SttTtsPlugin] clearChatContext => done");
  }
  /**
   * Cleanup resources
   */
  cleanup() {
    console.warn(`Close was called`);
    if (this.deepgramSocket && this.deepgramSocket.getReadyState() === SOCKET_STATES.OPEN) {
      this.deepgramSocket.disconnect();
      console.log("[SttTtsPlugin] Deepgram WebSocket closed");
    }
    if (this.ttsAbortController) {
      this.ttsAbortController.abort();
      this.ttsAbortController = null;
    }
    this.activeStreamManager.cleanup();
    this.latestActiveStreamId = null;
    this.eventEmitter.removeAllListeners();
    elizaLogger6.log("[SttTtsPlugin] Cleanup complete");
  }
};

// src/spaces.ts
import { SpaceParticipant } from "@flooz-link/agent-twitter-client";
async function generateFiller(runtime, fillerType) {
  try {
    const context = `
    # INSTRUCTIONS:
  You are generating a short filler message for a Twitter Space. The filler type is "${fillerType}".
  Keep it brief, friendly, and relevant. No more than two sentences.
  Only return the text, no additional formatting.

  ---`;
    const output = await generateText3({
      runtime,
      context,
      modelClass: ModelClass4.SMALL
    });
    return output.trim();
  } catch (err) {
    elizaLogger7.error("[generateFiller] Error generating filler:", err);
    return "";
  }
}
async function speakFiller(runtime, sttTtsPlugin, fillerType, sleepAfterMs = 3e3) {
  if (!sttTtsPlugin) return;
  const text = await generateFiller(runtime, fillerType);
  if (!text) return;
  elizaLogger7.log(`[Space] Filler (${fillerType}) => ${text}`);
  await sttTtsPlugin.speakText(text);
  if (sleepAfterMs > 0) {
    await new Promise((res) => setTimeout(res, sleepAfterMs));
  }
}
async function generateTopicsIfEmpty(runtime) {
  try {
    const context = `# INSTRUCTIONS:
Please generate 5 short topic ideas for a Twitter Space about technology or random interesting subjects.
Return them as a comma-separated list, no additional formatting or numbering.

Example:
"AI Advances, Futuristic Gadgets, Space Exploration, Quantum Computing, Digital Ethics"
---
`;
    const response = await generateText3({
      runtime,
      context,
      modelClass: ModelClass4.SMALL
    });
    const topics = response.split(",").map((t) => t.trim()).filter(Boolean);
    return topics.length ? topics : ["Random Tech Chat", "AI Thoughts"];
  } catch (err) {
    elizaLogger7.error("[generateTopicsIfEmpty] GPT error =>", err);
    return ["Random Tech Chat", "AI Thoughts"];
  }
}
var TwitterSpaceClient = class {
  runtime;
  client;
  scraper;
  isSpaceRunning = false;
  currentSpace;
  spaceId;
  startedAt;
  checkInterval;
  lastSpaceEndedAt;
  sttTtsPlugin;
  /**
   * We now store an array of active speakers, not just 1
   */
  activeSpeakers = [];
  speakerQueue = [];
  decisionOptions;
  constructor(client, runtime) {
    this.client = client;
    this.scraper = client.twitterClient;
    this.runtime = runtime;
    const charSpaces = runtime.character.twitterSpaces || {};
    this.decisionOptions = {
      maxSpeakers: charSpaces.maxSpeakers ?? 1,
      topics: charSpaces.topics ?? [],
      typicalDurationMinutes: charSpaces.typicalDurationMinutes ?? 30,
      idleKickTimeoutMs: charSpaces.idleKickTimeoutMs ?? 5 * 6e4,
      minIntervalBetweenSpacesMinutes: charSpaces.minIntervalBetweenSpacesMinutes ?? 60,
      businessHoursOnly: charSpaces.businessHoursOnly ?? false,
      randomChance: charSpaces.randomChance ?? 0.3,
      enableIdleMonitor: charSpaces.enableIdleMonitor !== false,
      enableSttTts: charSpaces.enableSttTts !== false,
      enableRecording: charSpaces.enableRecording !== false,
      voiceId: charSpaces.voiceId || runtime.character.settings.voice.model || "Xb7hH8MSUJpSbSDYk0k2",
      sttLanguage: charSpaces.sttLanguage || "en",
      speakerMaxDurationMs: charSpaces.speakerMaxDurationMs ?? 4 * 6e4,
      silenceThreshold: charSpaces.silenceThreshold,
      silenceDetectionWindow: charSpaces.silenceDetectionWindow
    };
  }
  async joinSpace(spaceId) {
    var _a, _b;
    this.spaceId = spaceId;
    this.isSpaceRunning = true;
    elizaLogger7.log("[Space] Joining a new Twitter Space...");
    try {
      this.startedAt = Date.now();
      this.activeSpeakers = [];
      this.speakerQueue = [];
      const elevenLabsKey = this.runtime.getSetting("ELEVENLABS_XI_API_KEY") || "";
      const participant = new SpaceParticipant(this.scraper, {
        spaceId: this.spaceId,
        debug: false
      });
      await participant.joinAsListener();
      console.log("[TestParticipant] HLS URL =>", participant.getHlsUrl());
      const { sessionUUID } = await participant.requestSpeaker();
      console.log("[TestParticipant] Requested speaker =>", sessionUUID);
      try {
        try {
          await this.waitForApproval(
            participant,
            sessionUUID,
            isNotEmpty((_a = this.decisionOptions) == null ? void 0 : _a.speakerApprovalWaitTime) ? this.decisionOptions.speakerApprovalWaitTime : 15e3
          );
        } catch (error) {
          elizaLogger7.warn(`Speaker request was not approved, error ${error}`);
          await participant.cancelSpeakerRequest();
          throw error;
        }
        if (this.decisionOptions.enableRecording) {
          elizaLogger7.log("[Space] Using RecordToDiskPlugin");
          const recordToDisk = new RecordToDiskPlugin();
          recordToDisk.init({
            space: participant
          });
          participant.use(recordToDisk);
        }
        if (this.decisionOptions.enableSttTts) {
          elizaLogger7.log("[Space] Using SttTtsPlugin");
          const sttTts = new SttTtsPlugin();
          sttTts.init({
            space: participant,
            pluginConfig: {
              user: this.client.profile,
              runtime: this.runtime,
              client: this.client,
              spaceId: this.spaceId,
              elevenLabsApiKey: elevenLabsKey,
              voiceId: this.decisionOptions.voiceId,
              sttLanguage: this.decisionOptions.sttLanguage,
              transcriptionService: this.client.runtime.getService(
                ServiceType4.TRANSCRIPTION
              ),
              silenceThreshold: this.decisionOptions.silenceThreshold,
              silenceDetectionWindow: ((_b = this.decisionOptions) == null ? void 0 : _b.silenceDetectionWindow) ?? 400
            }
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
              ServiceType4.TRANSCRIPTION
            ),
            silenceThreshold: this.decisionOptions.silenceThreshold
          });
        }
        if (this.decisionOptions.enableIdleMonitor) {
          elizaLogger7.log("[Space] Using IdleMonitorPlugin");
          participant.use(
            new IdleMonitorPlugin(
              this.decisionOptions.idleKickTimeoutMs ?? 6e4,
              1e4
            )
          );
        }
        this.isSpaceRunning = true;
        participant.on("idleTimeout", async (info) => {
          elizaLogger7.log(
            `[Space] idleTimeout => no audio for ${info.idleMs} ms.`
          );
          await speakFiller(
            this.client.runtime,
            this.sttTtsPlugin,
            "IDLE_ENDING"
          );
          await this.stopSpace();
        });
        participant.on("error", (error) => {
          elizaLogger7.error(`Error on client connection ${error}`);
        });
        process.on("SIGINT", async () => {
          elizaLogger7.log("[Space] SIGINT => stopping space");
          await speakFiller(this.client.runtime, this.sttTtsPlugin, "CLOSING");
          await this.stopSpace();
          process.exit(0);
        });
      } catch (error) {
        elizaLogger7.error("[Space] Error launching Space =>", error);
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
  async waitForApproval(participant, sessionUUID, timeoutMs = 1e4) {
    return new Promise((resolve, reject) => {
      let resolved = false;
      const handler = async (evt) => {
        if (evt.sessionUUID === sessionUUID) {
          resolved = true;
          participant.off("newSpeakerAccepted", handler);
          try {
            await participant.becomeSpeaker();
            console.log("[TestParticipant] Successfully became speaker!");
            resolve();
          } catch (err) {
            reject(err);
          }
        }
      };
      participant.on("newSpeakerAccepted", handler);
      setTimeout(() => {
        if (!resolved) {
          participant.off("newSpeakerAccepted", handler);
          reject(
            new Error(
              `[TestParticipant] Timed out waiting for speaker approval after ${timeoutMs}ms.`
            )
          );
        }
      }, timeoutMs);
    });
  }
  /**
   * Periodic check to launch or manage space
   */
  async startPeriodicSpaceCheck() {
    elizaLogger7.log("[Space] Starting periodic check routine...");
    const intervalMsWhenIdle = 5 * 6e4;
    const intervalMsWhenRunning = 5e3;
    const routine = async () => {
      try {
        if (!this.isSpaceRunning) {
          const launch = await this.shouldLaunchSpace();
          if (launch) {
            const config = await this.generateSpaceConfig();
            await this.startSpace(config);
          }
          this.checkInterval = setTimeout(
            routine,
            this.isSpaceRunning ? intervalMsWhenRunning : intervalMsWhenIdle
          );
        } else {
          await this.manageCurrentSpace();
          this.checkInterval = setTimeout(routine, intervalMsWhenRunning);
        }
      } catch (error) {
        elizaLogger7.error("[Space] Error in routine =>", error);
        this.checkInterval = setTimeout(routine, intervalMsWhenIdle);
      }
    };
    routine();
  }
  stopPeriodicCheck() {
    if (this.checkInterval) {
      clearTimeout(this.checkInterval);
      this.checkInterval = void 0;
    }
  }
  async shouldLaunchSpace() {
    const r = Math.random();
    if (r > (this.decisionOptions.randomChance ?? 0.3)) {
      elizaLogger7.log("[Space] Random check => skip launching");
      return false;
    }
    if (this.decisionOptions.businessHoursOnly) {
      const hour = (/* @__PURE__ */ new Date()).getUTCHours();
      if (hour < 9 || hour >= 17) {
        elizaLogger7.log("[Space] Out of business hours => skip");
        return false;
      }
    }
    const now = Date.now();
    if (this.lastSpaceEndedAt) {
      const minIntervalMs = (this.decisionOptions.minIntervalBetweenSpacesMinutes ?? 60) * 6e4;
      if (now - this.lastSpaceEndedAt < minIntervalMs) {
        elizaLogger7.log("[Space] Too soon since last space => skip");
        return false;
      }
    }
    elizaLogger7.log("[Space] Deciding to launch a new Space...");
    return true;
  }
  async generateSpaceConfig() {
    var _a, _b, _c;
    const topicsLen = ((_b = (_a = this.decisionOptions) == null ? void 0 : _a.topics) == null ? void 0 : _b.length) ?? 0;
    if (topicsLen === 0) {
      const newTopics = await generateTopicsIfEmpty((_c = this.client) == null ? void 0 : _c.runtime);
      this.decisionOptions.topics = newTopics;
    }
    let chosenTopic = "Random Tech Chat";
    if (topicsLen > 0) {
      chosenTopic = this.decisionOptions.topics[Math.floor(Math.random() * topicsLen)];
    }
    return {
      mode: "INTERACTIVE",
      title: chosenTopic,
      description: `Discussion about ${chosenTopic}`,
      languages: ["en"]
    };
  }
  async startSpace(config) {
    elizaLogger7.log("[Space] Starting a new Twitter Space...");
    try {
      this.currentSpace = new Space(this.scraper);
      this.isSpaceRunning = false;
      this.spaceId = void 0;
      this.startedAt = Date.now();
      this.activeSpeakers = [];
      this.speakerQueue = [];
      const elevenLabsKey = this.runtime.getSetting("ELEVENLABS_XI_API_KEY") || "";
      const broadcastInfo = await this.currentSpace.initialize(config);
      this.spaceId = broadcastInfo.room_id;
      if (this.decisionOptions.enableRecording) {
        elizaLogger7.log("[Space] Using RecordToDiskPlugin");
        this.currentSpace.use(new RecordToDiskPlugin());
      }
      if (this.decisionOptions.enableSttTts) {
        elizaLogger7.log("[Space] Using SttTtsPlugin");
        const sttTts = new SttTtsPlugin();
        this.sttTtsPlugin = sttTts;
        this.currentSpace.use(sttTts, {
          runtime: this.runtime,
          client: this.client,
          spaceId: this.spaceId,
          elevenLabsApiKey: elevenLabsKey,
          voiceId: this.decisionOptions.voiceId,
          sttLanguage: this.decisionOptions.sttLanguage,
          transcriptionService: this.client.runtime.getService(
            ServiceType4.TRANSCRIPTION
          )
        });
      }
      if (this.decisionOptions.enableIdleMonitor) {
        elizaLogger7.log("[Space] Using IdleMonitorPlugin");
        this.currentSpace.use(
          new IdleMonitorPlugin(
            this.decisionOptions.idleKickTimeoutMs ?? 6e4,
            1e4
          )
        );
      }
      this.isSpaceRunning = true;
      await this.scraper.sendTweet(
        broadcastInfo.share_url.replace("broadcasts", "spaces")
      );
      const spaceUrl = broadcastInfo.share_url.replace("broadcasts", "spaces");
      elizaLogger7.log(`[Space] Space started => ${spaceUrl}`);
      await speakFiller(this.client.runtime, this.sttTtsPlugin, "WELCOME");
      this.currentSpace.on("occupancyUpdate", (update) => {
        elizaLogger7.log(
          `[Space] Occupancy => ${update.occupancy} participant(s).`
        );
      });
      this.currentSpace.on("speakerRequest", async (req) => {
        elizaLogger7.log(
          `[Space] Speaker request from @${req.username} (${req.userId}).`
        );
        await this.handleSpeakerRequest(req);
      });
      this.currentSpace.on("idleTimeout", async (info) => {
        elizaLogger7.log(
          `[Space] idleTimeout => no audio for ${info.idleMs} ms.`
        );
        await speakFiller(
          this.client.runtime,
          this.sttTtsPlugin,
          "IDLE_ENDING"
        );
        await this.stopSpace();
      });
      process.on("SIGINT", async () => {
        elizaLogger7.log("[Space] SIGINT => stopping space");
        await speakFiller(this.client.runtime, this.sttTtsPlugin, "CLOSING");
        await this.stopSpace();
        process.exit(0);
      });
    } catch (error) {
      elizaLogger7.error("[Space] Error launching Space =>", error);
      this.isSpaceRunning = false;
      throw error;
    }
  }
  /**
   * Periodic management: check durations, remove extras, maybe accept new from queue
   */
  async manageCurrentSpace() {
    var _a, _b, _c, _d;
    if (!this.spaceId || !this.currentSpace) {
      return;
    }
    try {
      const audioSpace = await this.scraper.getAudioSpaceById(this.spaceId);
      const { participants } = audioSpace;
      const numSpeakers = ((_a = participants.speakers) == null ? void 0 : _a.length) || 0;
      const totalListeners = ((_b = participants.listeners) == null ? void 0 : _b.length) || 0;
      const activeSpeakerLen = ((_c = this == null ? void 0 : this.activeSpeakers) == null ? void 0 : _c.length) ?? 0;
      if (activeSpeakerLen === 0) {
        elizaLogger7.log(
          `No active speakers to manage, hence nothing to manage, returning`
        );
        return;
      }
      const maxDur = ((_d = this.decisionOptions) == null ? void 0 : _d.speakerMaxDurationMs) ?? 24e4;
      const now = Date.now();
      for (let i = this.activeSpeakers.length - 1; i >= 0; i--) {
        const speaker = this.activeSpeakers[i];
        const elapsed = now - ((speaker == null ? void 0 : speaker.startTime) ?? now);
        if (elapsed > maxDur) {
          elizaLogger7.log(
            `[Space] Speaker @${speaker == null ? void 0 : speaker.username} exceeded max duration => removing`
          );
          if (isNotEmpty(speaker == null ? void 0 : speaker.userId)) {
            await this.removeSpeaker(speaker == null ? void 0 : speaker.userId);
            this.activeSpeakers.splice(i, 1);
            await speakFiller(
              this.client.runtime,
              this.sttTtsPlugin,
              "SPEAKER_LEFT"
            );
          }
        }
      }
      await this.acceptSpeakersFromQueueIfNeeded();
      if (numSpeakers > (this.decisionOptions.maxSpeakers ?? 1)) {
        elizaLogger7.log("[Space] More than maxSpeakers => removing extras...");
        await this.kickExtraSpeakers(participants.speakers);
      }
      const elapsedMinutes = (now - (this.startedAt || 0)) / 6e4;
      if (elapsedMinutes > (this.decisionOptions.typicalDurationMinutes ?? 30) || numSpeakers === 0 && totalListeners === 0 && elapsedMinutes > 5) {
        elizaLogger7.log("[Space] Condition met => stopping the Space...");
        await speakFiller(
          this.client.runtime,
          this.sttTtsPlugin,
          "CLOSING",
          4e3
        );
        await this.stopSpace();
      }
    } catch (error) {
      elizaLogger7.error("[Space] Error in manageCurrentSpace =>", error);
    }
  }
  /**
   * If we have available slots, accept new speakers from the queue
   */
  async acceptSpeakersFromQueueIfNeeded() {
    var _a, _b, _c;
    const maxNumberOfSpeakersConfigured = ((_a = this == null ? void 0 : this.decisionOptions) == null ? void 0 : _a.maxSpeakers) ?? 1;
    const speakerQueueLen = ((_b = this.speakerQueue) == null ? void 0 : _b.length) ?? 0;
    const activeSpeakerLen = ((_c = this.activeSpeakers) == null ? void 0 : _c.length) ?? 0;
    while (speakerQueueLen > 0 && activeSpeakerLen < maxNumberOfSpeakersConfigured) {
      const nextReq = this.speakerQueue.shift();
      if (nextReq) {
        await speakFiller(this.client.runtime, this.sttTtsPlugin, "PRE_ACCEPT");
        await this.acceptSpeaker(nextReq);
      }
    }
  }
  async handleSpeakerRequest(req) {
    var _a, _b;
    if (isEmpty(this.spaceId) || isEmpty(this.currentSpace)) {
      return;
    }
    const audioSpace = await this.scraper.getAudioSpaceById(this.spaceId);
    const janusSpeakers = ((_a = audioSpace == null ? void 0 : audioSpace.participants) == null ? void 0 : _a.speakers) || [];
    const maxSpeakersConfiguredLen = ((_b = this.decisionOptions) == null ? void 0 : _b.maxSpeakers) ?? 1;
    if (janusSpeakers.length < maxSpeakersConfiguredLen) {
      elizaLogger7.log(`[Space] Accepting speaker @${req.username} now`);
      await speakFiller(this.client.runtime, this.sttTtsPlugin, "PRE_ACCEPT");
      await this.acceptSpeaker(req);
    } else {
      elizaLogger7.log(`[Space] Adding speaker @${req.username} to the queue`);
      this.speakerQueue.push(req);
    }
  }
  async acceptSpeaker(req) {
    var _a;
    if (isEmpty(this.currentSpace)) {
      return;
    }
    try {
      await ((_a = this.currentSpace) == null ? void 0 : _a.approveSpeaker(req.userId, req.sessionUUID));
      this.activeSpeakers.push({
        userId: req.userId,
        sessionUUID: req.sessionUUID,
        username: req.username,
        startTime: Date.now()
      });
      elizaLogger7.log(`[Space] Speaker @${req.username} is now live`);
    } catch (err) {
      elizaLogger7.error(
        `[Space] Error approving speaker @${req.username}:`,
        err
      );
    }
  }
  async removeSpeaker(userId) {
    if (isEmpty(this.currentSpace)) {
      return;
    }
    if (isEmpty(userId)) {
      return;
    }
    try {
      await this.currentSpace.removeSpeaker(userId);
      elizaLogger7.log(`[Space] Removed speaker userId=${userId}`);
    } catch (error) {
      elizaLogger7.error(
        `[Space] Error removing speaker userId=${userId} =>`,
        error
      );
    }
  }
  /**
   * If more than maxSpeakers are found, remove extras
   * Also update activeSpeakers array
   */
  async kickExtraSpeakers(speakers) {
    var _a;
    if (isEmpty(this.currentSpace)) {
      return;
    }
    const speakersLen = (speakers == null ? void 0 : speakers.length) ?? 0;
    if (speakersLen === 0) {
      return;
    }
    const ms = ((_a = this.decisionOptions) == null ? void 0 : _a.maxSpeakers) ?? 1;
    const extras = (speakers == null ? void 0 : speakers.slice(ms)) ?? [];
    for (const sp of extras) {
      elizaLogger7.log(`[Space] Removing extra speaker => userId=${sp.user_id}`);
      await this.removeSpeaker(sp.user_id);
      const idx = this.activeSpeakers.findIndex((s) => s.userId === sp.user_id);
      if (idx !== -1) {
        this.activeSpeakers.splice(idx, 1);
      }
    }
  }
  async stopSpace() {
    var _a;
    if (isEmpty(this.currentSpace) || isEmpty(this.isSpaceRunning)) {
      return;
    }
    try {
      elizaLogger7.log("[Space] Stopping the current Space...");
      await ((_a = this.currentSpace) == null ? void 0 : _a.stop());
    } catch (err) {
      elizaLogger7.error("[Space] Error stopping Space =>", err);
    } finally {
      this.isSpaceRunning = false;
      this.spaceId = void 0;
      this.currentSpace = void 0;
      this.startedAt = void 0;
      this.lastSpaceEndedAt = Date.now();
      this.activeSpeakers = [];
      this.speakerQueue = [];
    }
  }
};

// src/client.ts
var TwitterManager = class {
  client;
  post;
  search;
  interaction;
  space;
  constructor(runtime, twitterConfig) {
    this.client = new ClientBase(runtime, twitterConfig);
    this.post = new TwitterPostClient(this.client, runtime);
    if (twitterConfig.TWITTER_SEARCH_ENABLE) {
      elizaLogger8.warn("Twitter/X client running in a mode that:");
      elizaLogger8.warn("1. violates consent of random users");
      elizaLogger8.warn("2. burns your rate limit");
      elizaLogger8.warn("3. can get your account banned");
      elizaLogger8.warn("use at your own risk");
      this.search = new TwitterSearchClient(this.client, runtime);
    }
    this.interaction = new TwitterInteractionClient(this.client, runtime);
    if (twitterConfig.TWITTER_SPACES_ENABLE) {
      this.space = new TwitterSpaceClient(this.client, runtime);
    }
  }
  async stop() {
    elizaLogger8.warn("Twitter client does not support stopping yet");
  }
};
var TwitterClientInterface = {
  name: "twitter",
  async start(runtime) {
    const twitterConfig = await validateTwitterConfig(runtime);
    elizaLogger8.log("Twitter client started");
    const manager = new TwitterManager(runtime, twitterConfig);
    await manager.client.init();
    await manager.post.start();
    if (manager.search) {
      await manager.search.start();
    }
    await manager.interaction.start();
    if (manager.space) {
      manager.space.startPeriodicSpaceCheck();
    }
    return manager;
  },
  async joinSpace(manager, spaceId) {
    if (manager.space) {
      return manager.space.joinSpace(spaceId);
    }
    return;
  }
};
export {
  TwitterClientInterface,
  TwitterClientInterface as default
};
//# sourceMappingURL=index.js.map