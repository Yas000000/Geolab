// The width every data page is centered in: the account bar, the client tabs
// (and their header), All Clients, Access and run pages. 96rem (1536px) so the
// GEO Rankings tab's Prompt Rankings table shows all its columns on load from
// a 1280px screen up; the user asked for every tab and page to match it
// (2026-11-18). Single-column forms (New Client, Settings, a client's login,
// Account) keep their own narrower widths, and reports are letter-size.
export const PAGE_WIDTH = "max-w-[96rem]";
