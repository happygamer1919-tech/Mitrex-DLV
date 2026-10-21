import type { FormEvent } from "react";

// DLV-043 FORM-RESET-01: a form that must keep what was typed when the server refuses it submits through onSubmit,
// never the form action prop. React resets a form after an action prop ran, so a refused save wiped every uncontrolled
// field (and WebKit blanked a controlled select). The action (the dispatch of useActionState) runs inside the given
// transition, so its pending flag still works. A form that should clear after a success does that itself (a new key,
// or form.reset() when the result is ok).
export function submitWithoutReset(action: (fd: FormData) => void, start: (fn: () => void) => void) {
  return (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const fd = new FormData(e.currentTarget);
    start(() => action(fd));
  };
}
