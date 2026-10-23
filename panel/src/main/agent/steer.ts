// Steering: text the user adds while a turn runs (pure).

/**
 * Puts the user's added text into the request for the next pass. A user
 * message right after tool results breaks local chat templates that expect
 * strict turns, so a local model gets it at the end of the last tool result
 * (or the last user message); cloud APIs take a real user message.
 */
export function joinSteer(messages: any[], note: string, remote: boolean): void {
  const last = messages[messages.length - 1];
  const appendTo = (m: any, key: "content" | "output"): boolean => {
    if (typeof m[key] === "string") { m[key] = `${m[key]}\n\n${note}`; return true; }
    if (Array.isArray(m[key])) { m[key] = [...m[key], { type: "text", text: note }]; return true; }
    return false;
  };
  if (last?.role === "user" && appendTo(last, "content")) return;
  if (!remote && last) {
    if (last.role === "tool" && appendTo(last, "content")) return;
    if (last.type === "function_call_output" && typeof last.output === "string" && appendTo(last, "output")) return;
  }
  messages.push({ role: "user", content: note });
}
