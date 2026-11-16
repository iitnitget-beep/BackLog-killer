/** `.md` files are imported as text (esbuild `--loader:.md=text`, vitest raw plugin). */
declare module '*.md' {
  const content: string;
  export default content;
}
