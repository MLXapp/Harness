/**
 * Ask aside (⌘;): the request messages for a side question. Pure, so the
 * shape is unit-tested (tests/ask-aside.test.ts).
 */

/** Tells the model how to treat the side question. */
export const ASIDE_NOTE = "(A quick side question from the user. Answer it briefly from the conversation so far. Do not use tools, do not continue the task, and do not change any plan: this answer is not part of the conversation.)";

/**
 * Request messages for a side question: the chat as is, then the question.
 * When the chat already ends with the user's turn (a reply is still running),
 * the question joins that message, so roles keep alternating (some chat
 * templates refuse two user turns in a row).
 */
export function asideMessages(messages: any[], question: string): any[] {
  const out = messages.slice();
  const text = `${ASIDE_NOTE}\n\nQuestion: ${question}`;
  const last = out[out.length - 1];
  if (last?.role === "user") {
    if (typeof last.content === "string") out[out.length - 1] = { ...last, content: `${last.content}\n\n${text}` };
    else if (Array.isArray(last.content)) out[out.length - 1] = { ...last, content: [...last.content, { type: "text", text }] };
    else out.push({ role: "user", content: text });
  } else {
    out.push({ role: "user", content: text });
  }
  return out;
}
