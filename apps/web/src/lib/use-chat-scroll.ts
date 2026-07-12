import { computed, nextTick, ref } from "vue";

type ChatScrollState = { canScroll: boolean; atTop: boolean; atBottom: boolean };

export function useChatScroll() {
  const chatScrollRef = ref<HTMLDivElement | null>(null);
  const chatScrollState = ref<ChatScrollState>({ canScroll: false, atTop: true, atBottom: true });
  const chatScrollFrameClass = computed(() => ({
    "has-top-fade": chatScrollState.value.canScroll && !chatScrollState.value.atTop,
    "has-bottom-fade": chatScrollState.value.canScroll && !chatScrollState.value.atBottom
  }));
  let resizeObserver: ResizeObserver | undefined;
  let observedElement: HTMLDivElement | null = null;

  function scheduleChatScrollCheck() {
    void nextTick(() => {
      bindChatScrollObserver();
      updateChatScrollState();
    });
  }

  function bindChatScrollObserver() {
    const element = chatScrollRef.value;
    if (observedElement === element) return;
    resizeObserver?.disconnect();
    observedElement = element;
    if (!element) return;
    resizeObserver = new ResizeObserver(updateChatScrollState);
    resizeObserver.observe(element);
  }

  function updateChatScrollState() {
    const element = chatScrollRef.value;
    if (!element) {
      chatScrollState.value = { canScroll: false, atTop: true, atBottom: true };
      return;
    }
    const threshold = 2;
    chatScrollState.value = {
      canScroll: element.scrollHeight > element.clientHeight + threshold,
      atTop: element.scrollTop <= threshold,
      atBottom: element.scrollTop + element.clientHeight >= element.scrollHeight - threshold
    };
  }

  function disposeChatScroll() {
    resizeObserver?.disconnect();
    resizeObserver = undefined;
    observedElement = null;
  }

  return { chatScrollRef, chatScrollState, chatScrollFrameClass, scheduleChatScrollCheck, updateChatScrollState, disposeChatScroll };
}
