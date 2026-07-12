import { ref } from "vue";

export type MessageFeedback = "up" | "down" | undefined;

export function useMessageActions() {
  const messageFeedback = ref<Record<string, MessageFeedback>>({});
  const expandedMessageIds = ref<Set<string>>(new Set());

  async function copyMessage(message: { content: string }) {
    try {
      await navigator.clipboard.writeText(message.content);
    } catch {
      const textArea = document.createElement("textarea");
      textArea.value = message.content;
      textArea.style.position = "fixed";
      textArea.style.opacity = "0";
      document.body.appendChild(textArea);
      textArea.select();
      document.execCommand("copy");
      textArea.remove();
    }
  }

  function setMessageFeedback(message: { id: string }, value: "up" | "down") {
    messageFeedback.value = { ...messageFeedback.value, [message.id]: messageFeedback.value[message.id] === value ? undefined : value };
  }

  function toggleMessageExpanded(message: { id: string }) {
    const next = new Set(expandedMessageIds.value);
    if (next.has(message.id)) next.delete(message.id); else next.add(message.id);
    expandedMessageIds.value = next;
  }

  return { messageFeedback, expandedMessageIds, copyMessage, setMessageFeedback, toggleMessageExpanded };
}
