/** Build-time URL imports become self-contained data URLs in the browser library bundle. */
declare module '*.ttf?url' {
  /** Encoded TrueType program emitted by the library asset pipeline. */
  const url: string;
  export default url;
}
