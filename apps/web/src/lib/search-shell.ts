/**
 * Оболонка сторінок пошуку без зсувів (V3, етап 9). Статична оболонка (PPR) однакова для
 * будь-якої адреси, а форма над результатами згорнута в рядок, на старті — повна. Щоб заглушка
 * мала потрібний розмір з першого кадру, ранній скрипт (до відмальовування, як і тема) ставить
 * `data-search="results"` на `<html>`, а CSS показує відповідну заглушку (`ShellChoice`).
 *
 * Правило — те саме, що на сервері в спрощеному вигляді: є дата (`depart` / `in`) і це не
 * чернетка. Рідкісна розбіжність (дата є, а пошук невалідний) коштує лише одного зсуву.
 */
export function resultsInUrl(search: URLSearchParams): boolean {
  return search.get("draft") !== "1" && (search.has("depart") || search.has("in"));
}

export const SEARCH_SHELL_SCRIPT = `(function(){try{var q=new URLSearchParams(location.search);if(q.get("draft")!=="1"&&(q.has("depart")||q.has("in")))document.documentElement.setAttribute("data-search","results");}catch(e){}})();`;
