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
    elizaLogger.debug(homeTimeline, { depth: Number.POSITIVE_INFINITY });
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
  ModelClass as ModelClass5,
  ServiceType as ServiceType4
} from "@elizaos/core";
import {
  Space,
  RecordToDiskPlugin,
  IdleMonitorPlugin
} from "@flooz-link/agent-twitter-client";

// src/plugins/SttTtsSpacesPlugin.ts
import { spawn } from "child_process";
import {
  elizaLogger as elizaLogger6,
  stringToUuid as stringToUuid6,
  composeContext as composeContext4,
  getEmbeddingZeroVector as getEmbeddingZeroVector5,
  generateMessageResponse as generateMessageResponse3,
  ModelClass as ModelClass4
} from "@elizaos/core";

// src/plugins/templates.ts
import { messageCompletionFooter as messageCompletionFooter3, shouldRespondFooter as shouldRespondFooter2 } from "@elizaos/core";
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

// src/plugins/SttTtsSpacesPlugin.ts
import { PassThrough } from "stream";
import { EventEmitter as EventEmitter2 } from "events";
import OpenAI from "openai";
var VOLUME_WINDOW_SIZE = 100;
var SPEAKING_THRESHOLD = 0.05;
var SttTtsPlugin = class {
  name = "SttTtsPlugin";
  description = "Speech-to-text (OpenAI) + conversation + TTS (ElevenLabs)";
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
  /**
   * Map of user IDs to promises representing ongoing processing operations
   * Used to prevent duplicate processing for the same user while allowing
   * concurrent processing for different users
   */
  processingLocks = /* @__PURE__ */ new Map();
  transcriptionService;
  /**
   * userId => arrayOfChunks (PCM Int16)
   */
  pcmBuffers = /* @__PURE__ */ new Map();
  /**
   * For ignoring near-silence frames (if amplitude < threshold)
   */
  silenceThreshold = 50;
  /**
   * Time to wait before detecting silence, defaults to 1 second, i.e. if no one speaks for 1 second then agent checks if it should respond
   */
  silenceDetectionThreshold = 1e3;
  // TTS queue for sequentially speaking
  ttsQueue = [];
  isSpeaking = false;
  isProcessingAudio = false;
  userSpeakingTimer = null;
  volumeBuffers;
  ttsAbortController = null;
  eventEmitter = new EventEmitter2();
  onAttach(_space) {
    elizaLogger6.log("[SttTtsPlugin] onAttach => space was attached");
  }
  init(params) {
    var _a;
    elizaLogger6.log(
      "[SttTtsPlugin] init => Space fully ready. Subscribing to events."
    );
    this.space = params.space;
    this.janus = (_a = this.space) == null ? void 0 : _a.janusClient;
    const config = params.pluginConfig;
    this.runtime = config == null ? void 0 : config.runtime;
    this.client = config == null ? void 0 : config.client;
    this.spaceId = config == null ? void 0 : config.spaceId;
    this.elevenLabsApiKey = config == null ? void 0 : config.elevenLabsApiKey;
    this.transcriptionService = config.transcriptionService;
    if (typeof (config == null ? void 0 : config.silenceThreshold) === "number") {
      this.silenceThreshold = config.silenceThreshold;
    }
    if (typeof (config == null ? void 0 : config.silenceDetectionWindow) === "number") {
      this.silenceDetectionThreshold = config.silenceDetectionWindow;
    }
    if (typeof (config == null ? void 0 : config.silenceThreshold)) {
      if (config == null ? void 0 : config.voiceId) {
        this.voiceId = config.voiceId;
      }
    }
    if (config == null ? void 0 : config.elevenLabsModel) {
      this.elevenLabsModel = config.elevenLabsModel;
    }
    if (config == null ? void 0 : config.chatContext) {
      this.chatContext = config.chatContext;
    }
    if (config == null ? void 0 : config.grokApiKey) {
      this.grokApiKey = config == null ? void 0 : config.grokApiKey;
    }
    if (config == null ? void 0 : config.grokBaseUrl) {
      this.grokBaseUrl = config == null ? void 0 : config.grokBaseUrl;
    }
    this.volumeBuffers = /* @__PURE__ */ new Map();
    this.processingLocks = /* @__PURE__ */ new Map();
  }
  /**
   * Called whenever we receive PCM from a speaker
   */
  onAudioData(data) {
    if (this.isProcessingAudio) {
      return;
    }
    let maxVal = 0;
    for (let i = 0; i < data.samples.length; i++) {
      const val = Math.abs(data.samples[i]);
      if (val > maxVal) maxVal = val;
    }
    if (maxVal < this.silenceThreshold) {
      return;
    }
    if (this.userSpeakingTimer) {
      clearTimeout(this.userSpeakingTimer);
    }
    let arr = this.pcmBuffers.get(data.userId);
    if (!arr) {
      arr = [];
      this.pcmBuffers.set(data.userId, arr);
    }
    arr.push(data.samples);
    if (!this.isSpeaking) {
      this.userSpeakingTimer = setTimeout(() => {
        elizaLogger6.log(
          "[SttTtsPlugin] start processing audio for user =>",
          data.userId
        );
        this.userSpeakingTimer = null;
        this.processAudio(data.userId).catch(
          (err) => elizaLogger6.error("[SttTtsPlugin] handleSilence error =>", err)
        );
      }, this.silenceDetectionThreshold);
    } else {
      let volumeBuffer = this.volumeBuffers.get(data.userId);
      if (!volumeBuffer) {
        volumeBuffer = [];
        this.volumeBuffers.set(data.userId, volumeBuffer);
      }
      const samples = new Int16Array(
        data.samples.buffer,
        data.samples.byteOffset,
        data.samples.length / 2
      );
      const maxAmplitude = Math.max(...samples.map(Math.abs)) / 32768;
      volumeBuffer.push(maxAmplitude);
      if (volumeBuffer.length > VOLUME_WINDOW_SIZE) {
        volumeBuffer.shift();
      }
      const avgVolume = volumeBuffer.reduce((sum, v) => sum + v, 0) / VOLUME_WINDOW_SIZE;
      if (avgVolume > SPEAKING_THRESHOLD) {
        volumeBuffer.length = 0;
        if (this.ttsAbortController) {
          this.ttsAbortController.abort();
          this.isSpeaking = false;
          elizaLogger6.log("[SttTtsPlugin] TTS playback interrupted");
        }
      }
    }
  }
  /**
   * Add audio chunk for a user
   */
  addAudioChunk(userId, chunk) {
    var _a;
    if (!this.pcmBuffers.has(userId)) {
      this.pcmBuffers.set(userId, []);
    }
    (_a = this.pcmBuffers.get(userId)) == null ? void 0 : _a.push(chunk);
  }
  // /src/sttTtsPlugin.ts
  async convertPcmToWavInMemory(pcmData, sampleRate) {
    const numChannels = 1;
    const byteRate = sampleRate * numChannels * 2;
    const blockAlign = numChannels * 2;
    const dataSize = pcmData.length * 2;
    const buffer = new ArrayBuffer(44 + dataSize);
    const view = new DataView(buffer);
    this.writeString(view, 0, "RIFF");
    view.setUint32(4, 36 + dataSize, true);
    this.writeString(view, 8, "WAVE");
    this.writeString(view, 12, "fmt ");
    view.setUint32(16, 16, true);
    view.setUint16(20, 1, true);
    view.setUint16(22, numChannels, true);
    view.setUint32(24, sampleRate, true);
    view.setUint32(28, byteRate, true);
    view.setUint16(32, blockAlign, true);
    view.setUint16(34, 16, true);
    this.writeString(view, 36, "data");
    view.setUint32(40, dataSize, true);
    let offset = 44;
    for (let i = 0; i < pcmData.length; i++, offset += 2) {
      view.setInt16(offset, pcmData[i], true);
    }
    return buffer;
  }
  writeString(view, offset, text) {
    for (let i = 0; i < text.length; i++) {
      view.setUint8(offset + i, text.charCodeAt(i));
    }
  }
  /**
   * On speaker silence => flush STT => GPT => TTS => push to Janus
   */
  async processAudio(userId) {
    if (!this.processingLocks) {
      this.processingLocks = /* @__PURE__ */ new Map();
    }
    if (this.processingLocks.has(userId)) {
      await this.processingLocks.get(userId);
      return;
    }
    let resolveLock;
    const lockPromise = new Promise((resolve) => {
      resolveLock = resolve;
    });
    this.processingLocks.set(userId, lockPromise);
    try {
      const start = Date.now();
      elizaLogger6.log(
        "[SttTtsPlugin] Starting audio processing for user:",
        userId
      );
      const chunks = this.pcmBuffers.get(userId) || [];
      this.pcmBuffers.delete(userId);
      if (!chunks.length) {
        elizaLogger6.warn("[SttTtsPlugin] No audio chunks for user =>", userId);
        return;
      }
      elizaLogger6.log(
        `[SttTtsPlugin] Processing audio for user=${userId}, chunks=${chunks.length}`
      );
      const mergeBufferPromise = this.mergeAudioChunks(chunks);
      this.volumeBuffers.delete(userId);
      const merged = await mergeBufferPromise;
      console.log(`PCM merging took: ${Date.now() - start} ms`);
      const optimizedPcm = this.maybeDownsampleAudio(merged, 48e3, 16e3);
      const wavBufferPromise = this.convertPcmToWavInMemory(
        optimizedPcm,
        optimizedPcm === merged ? 48e3 : 16e3
      );
      const wavBuffer = await wavBufferPromise;
      console.log(`Convert Wav took: ${Date.now() - start} ms`);
      const transcriptionPromise = this.transcriptionService.transcribe(wavBuffer);
      const sttText = await transcriptionPromise;
      console.log(`Transcription took: ${Date.now() - start} ms`);
      elizaLogger6.log(`[SttTtsPlugin] Transcription result: "${sttText}"`);
      if (isEmpty(sttText == null ? void 0 : sttText.trim())) {
        elizaLogger6.warn(
          "[SttTtsPlugin] No speech recognized for user =>",
          userId
        );
        return;
      }
      elizaLogger6.log(
        `[SttTtsPlugin] STT => user=${userId}, text="${sttText}"`
      );
      let accumulatedText = "";
      let minChunkSize = 20;
      let currentChunk = "";
      let isSpeaking = false;
      this.eventEmitter.once("stream-start", () => {
        elizaLogger6.log("[SttTtsPlugin] Stream started for user:", userId);
      });
      this.eventEmitter.on("stream-chunk", async (chunk) => {
        if (isEmpty(chunk)) {
          return;
        }
        accumulatedText += chunk;
        currentChunk += chunk;
        if (currentChunk.length >= minChunkSize || /[.!?](\s|$)/.test(currentChunk)) {
          const chunkToProcess = currentChunk;
          currentChunk = "";
          if (!isSpeaking) {
            isSpeaking = true;
            await this.speakText(chunkToProcess);
            isSpeaking = false;
          } else {
            this.ttsQueue.push(chunkToProcess);
          }
        }
      });
      this.eventEmitter.once("stream-end", () => {
        if (currentChunk.length > 0) {
          this.ttsQueue.push(currentChunk);
        }
        elizaLogger6.log("[SttTtsPlugin] Stream ended for user:", userId);
        elizaLogger6.log(`[SttTtsPlugin] user=${userId}, complete reply="${accumulatedText}"`);
        this.eventEmitter.removeAllListeners("stream-chunk");
        this.eventEmitter.removeAllListeners("stream-start");
        this.eventEmitter.removeAllListeners("stream-end");
      });
      this.handleUserMessageStreaming(sttText, userId);
    } catch (error) {
      elizaLogger6.error("[SttTtsPlugin] processAudio error =>", error);
    } finally {
      this.processingLocks.delete(userId);
      resolveLock();
    }
  }
  /**
   * Helper method to merge audio chunks in a non-blocking way
   * This allows other operations to continue while CPU-intensive merging happens
   */
  async mergeAudioChunks(chunks) {
    return new Promise((resolve) => {
      setImmediate(() => {
        const totalLen = chunks.reduce((acc, c) => acc + c.length, 0);
        const merged = new Int16Array(totalLen);
        let offset = 0;
        for (const c of chunks) {
          merged.set(c, offset);
          offset += c.length;
        }
        resolve(merged);
      });
    });
  }
  /**
   * Downsample audio if needed for Whisper
   * Whisper works best with 16kHz audio
   */
  maybeDownsampleAudio(audio, originalSampleRate, targetSampleRate) {
    if (originalSampleRate <= targetSampleRate) {
      return audio;
    }
    const ratio = originalSampleRate / targetSampleRate;
    const newLength = Math.floor(audio.length / ratio);
    const result = new Int16Array(newLength);
    for (let i = 0; i < newLength; i++) {
      const sourceIndex = Math.floor(i * ratio);
      result[i] = audio[sourceIndex];
    }
    return result;
  }
  /**
   * Public method to queue a TTS request
   */
  async speakText(text) {
    this.ttsQueue.push(text);
    if (!this.isSpeaking) {
      this.isSpeaking = true;
      const start = Date.now();
      this.processTtsQueue().catch((err) => {
        elizaLogger6.error("[SttTtsPlugin] processTtsQueue error =>", err);
      }).then((res) => {
        console.log(`Voice took ${Date.now() - start}`);
        return res;
      });
    }
  }
  /**
   * Process the TTS queue with streaming optimizations
   */
  async processTtsQueue() {
    try {
      while (this.ttsQueue.length > 0) {
        const text = this.ttsQueue.shift();
        if (!text) continue;
        this.ttsAbortController = new AbortController();
        const { signal } = this.ttsAbortController;
        const startTime = Date.now();
        try {
          await this.streamTtsToJanus(text, signal);
          console.log(
            `[SttTtsPlugin] Total TTS streaming took: ${Date.now() - startTime}ms`
          );
          if (signal.aborted) {
            console.log("[SttTtsPlugin] TTS streaming was interrupted");
            return;
          }
        } catch (err) {
          console.error("[SttTtsPlugin] TTS streaming error =>", err);
        } finally {
          this.ttsAbortController = null;
        }
      }
    } catch (error) {
      console.error("[SttTtsPlugin] Queue processing error =>", error);
    } finally {
      this.isSpeaking = false;
    }
  }
  /**
   * Stop any ongoing TTS playback
   */
  stopSpeaking() {
    if (this.ttsAbortController) {
      this.ttsAbortController.abort();
    }
    this.ttsQueue = [];
  }
  /**
   * Stream TTS text to Janus with proper ordering and timing
   * @param text Text to convert to speech
   * @param signal Abort controller signal
   */
  async streamTtsToJanus(text, signal) {
    const SAMPLE_RATE = 48e3;
    const FRAME_SIZE = 480;
    const FRAME_DURATION_MS = 10;
    const mp3Stream = new PassThrough();
    const ffmpeg = spawn("ffmpeg", [
      // Input stream settings
      "-i",
      "pipe:0",
      "-f",
      "mp3",
      // Performance flags
      "-threads",
      "4",
      "-loglevel",
      "error",
      "-nostdin",
      "-fflags",
      "+nobuffer",
      "-flags",
      "+low_delay",
      "-probesize",
      "32",
      "-analyzeduration",
      "0",
      // Output settings - PCM audio
      "-f",
      "s16le",
      "-ar",
      SAMPLE_RATE.toString(),
      "-ac",
      "1",
      "pipe:1"
    ]);
    mp3Stream.pipe(ffmpeg.stdin);
    const audioBuffer = [];
    let processingComplete = false;
    const elevenLabsPromise = this.elevenLabsTtsStreaming(
      text,
      mp3Stream,
      signal
    );
    const processingPromise = new Promise((resolve, reject) => {
      let pcmBuffer = Buffer.alloc(0);
      ffmpeg.stdout.on("data", (chunk) => {
        try {
          if (signal.aborted) return;
          pcmBuffer = Buffer.concat([pcmBuffer, chunk]);
          while (pcmBuffer.length >= FRAME_SIZE * 2) {
            const frameBuffer = pcmBuffer.slice(0, FRAME_SIZE * 2);
            pcmBuffer = pcmBuffer.slice(FRAME_SIZE * 2);
            const frame = new Int16Array(
              frameBuffer.buffer,
              frameBuffer.byteOffset,
              FRAME_SIZE
            );
            const frameCopy = new Int16Array(FRAME_SIZE);
            frameCopy.set(frame);
            audioBuffer.push(frameCopy);
          }
        } catch (error) {
          reject(error);
        }
      });
      ffmpeg.stderr.on("data", (data) => {
        if (data.toString().includes("Error")) {
          console.error("[FFmpeg Streaming Error]", data.toString().trim());
        }
      });
      ffmpeg.on("close", (code) => {
        try {
          if (code !== 0 && !signal.aborted) {
            reject(
              new Error(`ffmpeg streaming process exited with code ${code}`)
            );
            return;
          }
          if (pcmBuffer.length > 0 && !signal.aborted) {
            const frameBuffer = Buffer.alloc(FRAME_SIZE * 2);
            pcmBuffer.copy(
              frameBuffer,
              0,
              0,
              Math.min(pcmBuffer.length, FRAME_SIZE * 2)
            );
            const frame = new Int16Array(FRAME_SIZE);
            const srcView = new Int16Array(
              frameBuffer.buffer,
              frameBuffer.byteOffset,
              FRAME_SIZE
            );
            frame.set(srcView);
            audioBuffer.push(frame);
          }
          processingComplete = true;
          resolve();
        } catch (error) {
          reject(error);
        }
      });
      ffmpeg.on("error", (err) => {
        reject(new Error(`FFmpeg process error: ${err.message}`));
      });
    });
    try {
      await Promise.race([
        processingPromise.catch((err) => {
          elizaLogger6.error("[SttTtsPlugin] Processing error:", err);
        }),
        // Also wait for a minimum buffer to build up before starting playback
        new Promise((resolve) => {
          const checkBuffer = () => {
            if (audioBuffer.length > 10 || signal.aborted) {
              resolve();
            } else {
              setTimeout(checkBuffer, 50);
            }
          };
          checkBuffer();
        })
      ]);
      let frameIndex = 0;
      const startTime = Date.now();
      while ((frameIndex < audioBuffer.length || !processingComplete) && !signal.aborted) {
        if (frameIndex >= audioBuffer.length && !processingComplete) {
          await new Promise((resolve) => {
            const waitForMoreFrames = () => {
              if (frameIndex < audioBuffer.length || processingComplete || signal.aborted) {
                resolve();
              } else {
                setTimeout(waitForMoreFrames, 20);
              }
            };
            waitForMoreFrames();
          });
          if (frameIndex >= audioBuffer.length) {
            break;
          }
        }
        const idealPlaybackTime = startTime + frameIndex * FRAME_DURATION_MS;
        const currentTime = Date.now();
        if (currentTime < idealPlaybackTime) {
          await new Promise(
            (r) => setTimeout(r, idealPlaybackTime - currentTime)
          );
        } else if (currentTime > idealPlaybackTime + 100) {
          const framesToSkip = Math.floor(
            (currentTime - idealPlaybackTime) / FRAME_DURATION_MS
          );
          if (framesToSkip > 0) {
            elizaLogger6.log(
              `[SttTtsPlugin] Skipping ${framesToSkip} frames to catch up`
            );
            frameIndex += framesToSkip;
            continue;
          }
        }
        const frame = audioBuffer[frameIndex];
        try {
          await this.streamChunkToJanus(frame, SAMPLE_RATE);
        } catch (error) {
          elizaLogger6.error(
            "[SttTtsPlugin] Error sending frame to Janus:",
            error
          );
        }
        frameIndex++;
      }
      await processingPromise;
      await elevenLabsPromise;
      elizaLogger6.log(
        `[SttTtsPlugin] Audio streaming completed: ${audioBuffer.length} frames played`
      );
    } catch (error) {
      if (signal.aborted) {
        elizaLogger6.log("[SttTtsPlugin] Audio streaming aborted");
      } else {
        elizaLogger6.error("[SttTtsPlugin] Audio streaming error:", error);
      }
      throw error;
    }
  }
  /**
   * Stream a single chunk of audio to Janus
   * Fixed to ensure exact byte length requirement is met
   */
  async streamChunkToJanus(samples, sampleRate) {
    const EXPECTED_SAMPLES = 480;
    const EXPECTED_BYTES = EXPECTED_SAMPLES * 2;
    return new Promise((resolve, reject) => {
      var _a, _b;
      try {
        if (samples.length !== EXPECTED_SAMPLES || samples.buffer.byteLength !== EXPECTED_BYTES) {
          const properSizedSamples = new Int16Array(EXPECTED_SAMPLES);
          const copySamples = Math.min(samples.length, EXPECTED_SAMPLES);
          for (let i = 0; i < copySamples; i++) {
            properSizedSamples[i] = samples[i];
          }
          const bufferView = new Int16Array(
            properSizedSamples.buffer,
            0,
            EXPECTED_SAMPLES
          );
          console.log(
            `[SttTtsPlugin] Sending audio frame: ${bufferView.length} samples, ${bufferView.buffer.byteLength} bytes`
          );
          (_a = this.janus) == null ? void 0 : _a.pushLocalAudio(bufferView, sampleRate);
        } else {
          console.log(
            `[SttTtsPlugin] Sending audio frame: ${samples.length} samples, ${samples.buffer.byteLength} bytes`
          );
          (_b = this.janus) == null ? void 0 : _b.pushLocalAudio(samples, sampleRate);
        }
        resolve();
      } catch (error) {
        console.error("[SttTtsPlugin] Error sending audio to Janus:", error);
        reject(error);
      }
    });
  }
  /**
   * Modified ElevenLabs TTS function that streams the response to a writable stream
   * instead of waiting for the full response
   */
  async elevenLabsTtsStreaming(text, outputStream, signal) {
    try {
      if (!this.elevenLabsApiKey) {
        throw new Error("[SttTtsPlugin] No ElevenLabs API key");
      }
      const apiKey = this.elevenLabsApiKey;
      const voiceId = this.voiceId;
      const url = `https://api.elevenlabs.io/v1/text-to-speech/${voiceId}/stream`;
      elizaLogger6.log(
        `[SttTtsPlugin] Starting ElevenLabs streaming TTS request`
      );
      const response = await fetch(url, {
        method: "POST",
        headers: {
          Accept: "audio/mpeg",
          "Content-Type": "application/json",
          "xi-api-key": apiKey
        },
        body: JSON.stringify({
          text,
          model_id: this.elevenLabsModel,
          voice_settings: {
            stability: 0.4,
            similarity_boost: 0.8
          }
        }),
        signal
      });
      if (!response.ok) {
        const errorText = await response.text();
        throw new Error(
          `ElevenLabs API error: ${response.status} ${response.statusText} - ${errorText}`
        );
      }
      if (!response.body) {
        throw new Error("Response body is null");
      }
      elizaLogger6.log(
        `[SttTtsPlugin] ElevenLabs response received, streaming to FFmpeg`
      );
      const reader = response.body.getReader();
      let done = false;
      let bytesReceived = 0;
      while (!done && !signal.aborted) {
        const { value, done: readerDone } = await reader.read();
        done = readerDone;
        if (value && !signal.aborted) {
          bytesReceived += value.length;
          outputStream.write(Buffer.from(value));
          if (bytesReceived % 1e4 < 1e3) {
            elizaLogger6.log(
              `[SttTtsPlugin] Streaming TTS: ${bytesReceived} bytes received`
            );
          }
        }
      }
      outputStream.end();
      elizaLogger6.log(
        `[SttTtsPlugin] ElevenLabs streaming completed: ${bytesReceived} total bytes`
      );
    } catch (error) {
      if (error.name === "AbortError") {
        elizaLogger6.log("[SttTtsPlugin] ElevenLabs request aborted");
      } else {
        elizaLogger6.error("[SttTtsPlugin] ElevenLabs streaming error:", error);
      }
      outputStream.end();
      throw error;
    }
  }
  /**
   * Handle User Message
   */
  async handleUserMessage(userText, userId) {
    var _a, _b, _c;
    const numericId = userId.replace("tw-", "");
    const roomId = stringToUuid6(`twitter_generate_room-${this.spaceId}`);
    const userUuid = stringToUuid6(`twitter-user-${numericId}`);
    await Promise.all([
      this.runtime.ensureUserExists(
        userUuid,
        userId,
        // Use full Twitter ID as username
        `Twitter User ${numericId}`,
        "twitter"
      ),
      this.runtime.ensureRoomExists(roomId),
      this.runtime.ensureParticipantInRoom(userUuid, roomId)
    ]);
    let start = Date.now();
    const memory = {
      id: stringToUuid6(`${roomId}-voice-message-${Date.now()}`),
      agentId: this.runtime.agentId,
      content: {
        text: userText,
        source: "twitter"
      },
      userId: userUuid,
      roomId,
      embedding: getEmbeddingZeroVector5(),
      createdAt: Date.now()
    };
    let [state] = await Promise.all([
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
      this.runtime.messageManager.createMemory(memory)
    ]);
    console.log(
      `Compose state and create memory took ${Date.now() - start} ms`
    );
    start = Date.now();
    state = await this.runtime.updateRecentMessageState(state);
    console.log(`Recent messages state update took ${Date.now() - start} ms`);
    const shouldIgnore = await this._shouldIgnore(memory);
    if (shouldIgnore) {
      return "";
    }
    start = Date.now();
    const context = composeContext4({
      state,
      template: ((_a = this.runtime.character.templates) == null ? void 0 : _a.twitterVoiceHandlerTemplate) || ((_b = this.runtime.character.templates) == null ? void 0 : _b.messageHandlerTemplate) || twitterVoiceHandlerTemplate
    });
    const responseContent = await this._generateResponse(memory, context);
    console.log(`Generating Response took ${Date.now() - start} ms`);
    const responseMemory = {
      id: stringToUuid6(`${memory.id}-voice-response-${Date.now()}`),
      agentId: this.runtime.agentId,
      userId: this.runtime.agentId,
      content: {
        ...responseContent,
        user: this.runtime.character.name,
        inReplyTo: memory.id
      },
      roomId,
      embedding: getEmbeddingZeroVector5()
    };
    const reply = (_c = responseMemory.content.text) == null ? void 0 : _c.trim();
    if (reply) {
      await this.runtime.messageManager.createMemory(responseMemory);
    }
    this.eventEmitter.emit("response", reply);
    return reply;
  }
  /**
   * Handle User Message with streaming support
   */
  async handleUserMessageStreaming(userText, userId) {
    var _a, _b;
    const openai = new OpenAI({
      apiKey: this.grokApiKey,
      baseURL: this.grokBaseUrl
    });
    const systemMessage = {
      role: "system",
      content: this.runtime.character.system
    };
    const userMessage = {
      role: "user",
      content: userText
    };
    const messages = [...this.chatContext, systemMessage, userMessage];
    this.eventEmitter.emit("stream-start");
    const stream = await openai.chat.completions.create({
      model: "grok-2-latest",
      messages,
      stream: true
    });
    let fullResponse = "";
    for await (const chunk of stream) {
      const content = ((_b = (_a = chunk.choices[0]) == null ? void 0 : _a.delta) == null ? void 0 : _b.content) || "";
      if (content) {
        fullResponse += content;
        this.eventEmitter.emit("stream-chunk", content);
      }
    }
    this.eventEmitter.emit("stream-end");
    if (fullResponse.trim()) {
      const responseMemory = {
        id: stringToUuid6(`${userId}-voice-response-${Date.now()}`),
        agentId: this.runtime.agentId,
        userId: this.runtime.agentId,
        content: {
          text: fullResponse,
          source: "twitter",
          user: this.runtime.character.name
          // inReplyTo: userId,
        },
        roomId: stringToUuid6(`twitter_generate_room-${this.spaceId}`),
        embedding: getEmbeddingZeroVector5()
      };
      await this.runtime.messageManager.createMemory(responseMemory);
    }
  }
  /**
   * Generate Response
   */
  async _generateResponse(message, context) {
    const { userId, roomId } = message;
    const response = await generateMessageResponse3({
      runtime: this.runtime,
      context,
      modelClass: ModelClass4.SMALL
    });
    response.source = "discord";
    if (!response) {
      elizaLogger6.error(
        "[SttTtsPlugin] No response from generateMessageResponse"
      );
      return;
    }
    await this.runtime.databaseAdapter.log({
      body: { message, context, response },
      userId,
      roomId,
      type: "response"
    });
    return response;
  }
  /**
   * Should Ignore
   */
  async _shouldIgnore(message) {
    var _a;
    elizaLogger6.debug("message.content: ", message.content);
    const messageStr = (_a = message == null ? void 0 : message.content) == null ? void 0 : _a.text;
    const messageLen = (messageStr == null ? void 0 : messageStr.length) ?? 0;
    if (messageLen < 3) {
      return true;
    }
    const loseInterestWords = [
      // telling the bot to stop talking
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
      // offensive words
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
   * Add a message (system, user or assistant) to the chat context.
   * E.g. to store conversation history or inject a persona.
   */
  addMessage(role, content) {
    this.chatContext.push({ role, content });
    elizaLogger6.log(
      `[SttTtsPlugin] addMessage => role=${role}, content=${content}`
    );
  }
  /**
   * Clear the chat context if needed.
   */
  clearChatContext() {
    this.chatContext = [];
    elizaLogger6.log("[SttTtsPlugin] clearChatContext => done");
  }
  cleanup() {
    elizaLogger6.log("[SttTtsPlugin] cleanup => releasing resources");
    this.pcmBuffers.clear();
    this.userSpeakingTimer = null;
    this.ttsQueue = [];
    this.isSpeaking = false;
    this.volumeBuffers.clear();
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
      modelClass: ModelClass5.SMALL
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
      modelClass: ModelClass5.SMALL
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
        await speakFiller(this.client.runtime, this.sttTtsPlugin, "WELCOME");
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