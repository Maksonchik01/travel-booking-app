"use server";

import type { ChatConversationBody, ChatSyncState } from "@tickets/shared";

import { call, sessionToken } from "@/lib/session";

/** Без входу — `signedIn: false`; синхронізації немає, історія лише в браузері. */
export type ChatSync = { signedIn: false } | ({ signedIn: true } & ChatSyncState);

export async function loadChatSync(): Promise<ChatSync> {
  if (!(await sessionToken())) return { signedIn: false };
  const result = await call<ChatSyncState>("GET", "/account/chats");
  if (!result.ok) return { signedIn: false };
  return { signedIn: true, ...result.data };
}

/** Згода (увімкнути) чи її відкликання (вимкнути — сервер видаляє розмови з акаунта). */
export async function setChatSync(enabled: boolean): Promise<ChatSync> {
  if (!(await sessionToken())) return { signedIn: false };
  const result = await call<ChatSyncState>("PUT", "/account/chats/sync", { enabled });
  if (!result.ok) return { signedIn: false };
  return { signedIn: true, ...result.data };
}

export async function saveChat(id: string, body: ChatConversationBody): Promise<boolean> {
  if (!(await sessionToken())) return false;
  return (await call("PUT", `/account/chats/${encodeURIComponent(id)}`, body)).ok;
}

export async function deleteChat(id: string): Promise<void> {
  if (!(await sessionToken())) return;
  await call("DELETE", `/account/chats/${encodeURIComponent(id)}`);
}
