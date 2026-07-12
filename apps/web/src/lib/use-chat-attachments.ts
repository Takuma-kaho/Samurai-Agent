import { ref } from "vue";

export type PromptAttachment = {
  id: string;
  name: string;
  previewUrl: string;
  size: number;
  type: string;
};

export function useChatAttachments() {
  const attachmentInput = ref<HTMLInputElement | null>(null);
  const selectedAttachments = ref<PromptAttachment[]>([]);

  function openAttachmentPicker() {
    attachmentInput.value?.click();
  }

  function handleAttachmentSelection(event: Event) {
    const input = event.target as HTMLInputElement;
    const files = Array.from(input.files ?? []);
    clearAttachments();
    selectedAttachments.value = files.map((file) => ({
      id: `${file.name}-${file.size}-${file.lastModified}`,
      name: file.name,
      previewUrl: URL.createObjectURL(file),
      size: file.size,
      type: file.type
    }));
    input.value = "";
  }

  function removeAttachment(id: string) {
    const attachment = selectedAttachments.value.find((item) => item.id === id);
    if (attachment) URL.revokeObjectURL(attachment.previewUrl);
    selectedAttachments.value = selectedAttachments.value.filter((item) => item.id !== id);
  }

  function clearAttachments() {
    for (const attachment of selectedAttachments.value) URL.revokeObjectURL(attachment.previewUrl);
    selectedAttachments.value = [];
  }

  function formatFileSize(size: number): string {
    if (size < 1024 * 1024) return `${Math.max(1, Math.round(size / 1024))} KB`;
    return `${(size / 1024 / 1024).toFixed(1)} MB`;
  }

  return { attachmentInput, selectedAttachments, openAttachmentPicker, handleAttachmentSelection, removeAttachment, clearAttachments, formatFileSize };
}
