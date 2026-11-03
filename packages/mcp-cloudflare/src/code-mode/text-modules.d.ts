// Workers bundle `.txt` imports as Text modules: the default export is the file's contents.
declare module "*.txt" {
  const text: string;
  export default text;
}
