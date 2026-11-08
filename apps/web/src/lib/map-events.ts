/** Синхронізація «список → карта» житла: картка просить карту показати об'єкт. */
export const FOCUS_EVENT = "stay:focus";

export function focusStayOnMap(key: string) {
  window.dispatchEvent(new CustomEvent(FOCUS_EVENT, { detail: key }));
}
