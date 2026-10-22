/** The existing pure-JavaScript PNG codec, bundled into the I/O worker. */
declare module 'pngjs' {
  interface PngPixels {
    width: number
    height: number
    data: Buffer
  }
  export const PNG: {
    sync: {
      read(bytes: Buffer): PngPixels
      write(pixels: PngPixels): Buffer
    }
  }
}
