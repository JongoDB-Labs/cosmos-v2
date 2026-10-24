/**
 * COSMOS-202 T1 d: where the Teams tabs live. Pure (no server imports), so
 * the proxy can use it at the edge.
 */
export const TAB_PATH = "/teams/tab";

/** Is `pathname` the tab area: itself or below it, never a longer name? */
export const isTabPath = (pathname: string) => pathname === TAB_PATH || pathname.startsWith(`${TAB_PATH}/`);
