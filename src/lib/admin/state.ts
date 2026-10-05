export type ActionState = { ok?: string; error?: string };
export type AdminAction = (prev: ActionState, fd: FormData) => Promise<ActionState>;
