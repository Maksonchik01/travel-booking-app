/** Спільний вигляд полів форм: однакова висота, ховер і фокус у всіх полях. */
export const FIELD_CLASS =
  "h-11 rounded-lg bg-card shadow-xs transition-[color,border-color,box-shadow] hover:border-primary/40 focus-visible:border-primary";

/** Нативний <select> у тому ж стилі, що й <Input>. */
export const SELECT_CLASS = `${FIELD_CLASS} border-input w-full cursor-pointer border px-3 text-sm outline-none focus-visible:ring-3 focus-visible:ring-ring/40`;
