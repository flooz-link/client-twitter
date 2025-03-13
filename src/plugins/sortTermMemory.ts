import { isEmpty } from '../utils';

export interface ChatInteraction {
  role: 'system' | 'user' | 'assistant';
  content: string;
  startedAt: number;
  userId: string;
}

export class ShortTermMemory {
  private chatContext: Map<string, ChatInteraction[]> = new Map();
  private cleanupTimeout: NodeJS.Timeout;

  private readonly MAX_MEMORY_MESSAGES = 1000;
  private readonly MAX_MEMORY_TIME = 60 * 60 * 1000; // 1 hour in milliseconds

  constructor() {
    this.chatContext = new Map();
    this.cleanupTimeout = setInterval(() => {
      this.cleanup();
    }, 10 * 1000); // Run cleanup every 10 seconds
  }

  /**
   * Add a message to the chat context
   */
  public addMessage(
    role: 'system' | 'user' | 'assistant',
    content: string,
    userId: string,
  ) {
    if (isEmpty(content)) {
      return;
    }
    const existingMessages = this.chatContext.get(userId) ?? [];
    existingMessages.push({ role, content, startedAt: Date.now(), userId });
    this.chatContext.set(userId, existingMessages);
  }

  public getChatContext(): ChatInteraction[] {
    return Array.from(this.chatContext.values()).flat();
  }

  /**
   * Get chat interactions for a specific user, limited to the most recent messages
   * @param userId The user ID to get chat context for
   * @param limit Maximum number of messages to return (defaults to MAX_MEMORY_MESSAGES)
   * @returns Array of chat interactions for the specified user
   */
  public getChatContextByUserId(
    userId: string,
    limit: number = this.MAX_MEMORY_MESSAGES,
  ): ChatInteraction[] {
    const userMessages = this.chatContext.get(userId) ?? [];

    // If requested limit is greater than or equal to available messages, return all
    if (limit >= userMessages.length) {
      return userMessages;
    }

    // Otherwise, return only the most recent messages up to the limit
    // Sort from newest to oldest, take the first 'limit' messages, then restore chronological order
    return [...userMessages]
      .sort((a, b) => b.startedAt - a.startedAt)
      .slice(0, limit)
      .sort((a, b) => a.startedAt - b.startedAt);
  }

  public clearChatContext() {
    this.chatContext.clear();
  }

  cleanup = () => {
    const now = Date.now();

    // Process each user's message list separately
    for (const [userId, messages] of this.chatContext.entries()) {
      // Sort messages from newest to oldest
      const sortedMessages = [...messages].sort(
        (a, b) => b.startedAt - a.startedAt,
      );

      // Initialize a new array to hold messages we'll keep
      const messagesToKeep: ChatInteraction[] = [];

      // Keep up to MAX_MEMORY_MESSAGES that are within the time limit
      for (const message of sortedMessages) {
        // Skip messages that are too old
        if (now - message.startedAt > this.MAX_MEMORY_TIME) {
          continue;
        }

        // Add this message to our "keep" list
        messagesToKeep.push(message);

        // Stop if we've reached the maximum number of messages to keep
        if (messagesToKeep.length >= this.MAX_MEMORY_MESSAGES) {
          break;
        }
      }

      // If we kept all messages, no need to update
      if (messagesToKeep.length === messages.length) {
        continue;
      }

      // Re-sort to chronological order before storing
      messagesToKeep.sort((a, b) => a.startedAt - b.startedAt);

      // Update the map with the filtered messages
      if (messagesToKeep.length > 0) {
        this.chatContext.set(userId, messagesToKeep);
      } else {
        // If no messages remain, remove the entry entirely
        this.chatContext.delete(userId);
      }
    }
  };
}
