import type { ChatMode } from "@tickets/shared";

/**
 * «Оптимізувати з ШІ» (модуль 9b, планувальник → ШІ): кнопка на сторінці відкриває вкладку
 * помічника з новою розмовою потрібного режиму й чернеткою запиту. Поточну поїздку чат бере з
 * URL сторінки (усі параметри — без втрат), тож у події лише режим і текст.
 */
export const OPEN_CHAT_EVENT = "ai:open";

export type OpenChatDetail = { mode: ChatMode; draft: string };

export function openChat(detail: OpenChatDetail): void {
  window.dispatchEvent(new CustomEvent<OpenChatDetail>(OPEN_CHAT_EVENT, { detail }));
}
