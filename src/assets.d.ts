// Ambient module declarations for build-time asset imports (see
// lib/version.ts and lib/status-page.ts): bundlers inline these; plain Node
// execution falls back to reading the shipped file.

declare module "*.html" {
  const content: string;
  export default content;
}
