/**
 * Одноразові підказки (етап 9 розширення; без зсуву — V3, етап 9). Закриті — у localStorage;
 * ранній скрипт до першого кадру переносить їх у `data-hints` на `<html>`, а CSS ховає ці
 * підказки (`globals.css`). Так підказку рендерить сервер — вона малюється разом зі сторінкою,
 * а не з'являється пізніше (пізня поява ставала LCP і зсувала видачу).
 */
export const HINT_STORAGE_KEY = "tickets.hints.v1";
export const HINT_IDS = ["flightForm", "yourTrip", "explore"] as const;
export type HintId = (typeof HINT_IDS)[number];

export const HINTS_INIT_SCRIPT = `(function(){try{var v=JSON.parse(localStorage.getItem(${JSON.stringify(
  HINT_STORAGE_KEY,
)})||"[]");if(Array.isArray(v))document.documentElement.setAttribute("data-hints",v.filter(function(x){return typeof x==="string"&&/^[A-Za-z]+$/.test(x)}).join(" "));}catch(e){}})();`;
