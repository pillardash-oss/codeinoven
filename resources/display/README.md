# Bundled scrcpy server

`scrcpy-server-v5.0.1` is the unmodified server from the [scrcpy v5.0.1 release](https://github.com/Genymobile/scrcpy/releases/tag/v5.0.1), copyright Genymobile and Romain Vimont, licensed under the Apache License 2.0.

SHA-256: `764eb6f79811d5211fe9df341120882ba9994c7a61b897d7bf3fb662e53bc536` (matches the digest GitHub publishes for the release asset).

The device panel pushes it to an Android device to stream the screen as H.264 and to inject touch. Its version string must equal `SCRCPY_VERSION` in `src/main/display/stream/scrcpy-protocol.ts`, because the server refuses a client whose version differs. Upgrading means replacing this file and re-verifying the wire format in that module against the new release.
