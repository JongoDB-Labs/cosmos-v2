/**
 * The server refused a chat load: this member may not use chat (no CHAT_USE,
 * which every chat route requires). Not worth retrying, and not a connection
 * problem, so the drawer says which it is.
 */
export class ChatForbiddenError extends Error {
  constructor() {
    super("You don't have access to chat");
    this.name = "ChatForbiddenError";
  }
}
